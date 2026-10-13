#!/usr/bin/env bash
# Build release images, write digests, optionally cosign-sign, and pack a signed bundle (D27).
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cd "$ROOT"

VERSION="${VERSION:-$(node -p "require('./package.json').version")}"
REGISTRY="${REGISTRY:-}"
OUT_DIR="${OUT_DIR:-$ROOT/dist/release}"
TAG="${TAG:-$VERSION}"
SERVER_IMAGE="${SERVER_IMAGE:-visibility-maintenance-server:$TAG}"
WEB_IMAGE="${WEB_IMAGE:-visibility-maintenance-web:$TAG}"
COSIGN_KEY="${COSIGN_KEY:-}"
COSIGN_PASSWORD="${COSIGN_PASSWORD:-}"

mkdir -p "$OUT_DIR"
BUNDLE_DIR="$OUT_DIR/bundle-$VERSION"
rm -rf "$BUNDLE_DIR"
mkdir -p "$BUNDLE_DIR/images" "$BUNDLE_DIR/docs"

echo "==> Building images"
docker build --target server -t "$SERVER_IMAGE" .
docker build --target web -t "$WEB_IMAGE" .

server_id="$(docker image inspect --format '{{.Id}}' "$SERVER_IMAGE")"
web_id="$(docker image inspect --format '{{.Id}}' "$WEB_IMAGE")"
cat >"$BUNDLE_DIR/images/digests.json" <<EOF
{
  "version": "$VERSION",
  "built_at": "$(date -u +%Y-%m-%dT%H:%M:%SZ)",
  "images": {
    "server": { "tag": "$SERVER_IMAGE", "id": "$server_id" },
    "web": { "tag": "$WEB_IMAGE", "id": "$web_id" }
  }
}
EOF

echo "==> Saving image archives"
docker save "$SERVER_IMAGE" -o "$BUNDLE_DIR/images/server.tar"
docker save "$WEB_IMAGE" -o "$BUNDLE_DIR/images/web.tar"

cp deploy/private/compose.yaml "$BUNDLE_DIR/"
cp deploy/private/compose.neo.yaml "$BUNDLE_DIR/" 2>/dev/null || true
cp deploy/private/README.md "$BUNDLE_DIR/docs/"
cp docs/09_TEST_AND_ACCEPTANCE_PLAN.md "$BUNDLE_DIR/docs/" 2>/dev/null || true
cp docs/13_COMPLETION_REPORT.md "$BUNDLE_DIR/docs/" 2>/dev/null || true

(
  cd "$BUNDLE_DIR"
  find . -type f ! -name 'SHA256SUMS' -print0 | sort -z | xargs -0 shasum -a 256 > SHA256SUMS
)

if command -v cosign >/dev/null 2>&1; then
  if [[ -n "$COSIGN_KEY" ]]; then
    echo "==> Signing images with cosign key $COSIGN_KEY"
    COSIGN_PASSWORD="$COSIGN_PASSWORD" cosign sign --yes --key "$COSIGN_KEY" "$SERVER_IMAGE"
    COSIGN_PASSWORD="$COSIGN_PASSWORD" cosign sign --yes --key "$COSIGN_KEY" "$WEB_IMAGE"
    COSIGN_PASSWORD="$COSIGN_PASSWORD" cosign sign-blob --yes --key "$COSIGN_KEY" \
      --output-signature "$BUNDLE_DIR/SHA256SUMS.sig" \
      --output-certificate "$BUNDLE_DIR/SHA256SUMS.pem" \
      "$BUNDLE_DIR/SHA256SUMS" || \
      COSIGN_PASSWORD="$COSIGN_PASSWORD" cosign sign-blob --yes --key "$COSIGN_KEY" \
        --output-signature "$BUNDLE_DIR/SHA256SUMS.sig" \
        "$BUNDLE_DIR/SHA256SUMS"
  else
    echo "==> cosign present but COSIGN_KEY unset; writing unsigned bundle with digests only"
  fi
else
  echo "==> cosign not installed; writing unsigned bundle with digests and SHA256SUMS (install cosign to sign)"
fi

if [[ -n "$REGISTRY" ]]; then
  echo "==> Tagging for registry $REGISTRY"
  docker tag "$SERVER_IMAGE" "$REGISTRY/visibility-maintenance-server:$TAG"
  docker tag "$WEB_IMAGE" "$REGISTRY/visibility-maintenance-web:$TAG"
fi

ARCHIVE="$OUT_DIR/visibility-maintenance-$VERSION-bundle.tar.gz"
tar -C "$OUT_DIR" -czf "$ARCHIVE" "$(basename "$BUNDLE_DIR")"
shasum -a 256 "$ARCHIVE" >"$ARCHIVE.sha256"
echo "Bundle: $ARCHIVE"
echo "Checksum: $(cat "$ARCHIVE.sha256")"
