# syntax=docker/dockerfile:1
# Release images for the private standalone package. Base images are pinned by
# digest; refresh them deliberately (docs/11: pin reviewed dependency versions).

ARG NODE_IMAGE=node:24-alpine@sha256:ebfe2f90462722a7a4de65e91990e97fe0d401c70e0e762c5b53302f905ec1c1
ARG NGINX_IMAGE=nginx:1.29-alpine@sha256:5616878291a2eed594aee8db4dade5878cf7edcb475e59193904b198d9b830de

FROM ${NODE_IMAGE} AS build
WORKDIR /src
COPY . .
RUN npm ci --ignore-scripts --no-audit --no-fund
RUN node tools/build.mjs
RUN if [ -f apps/maintenance-web/package.json ]; then npm run build -w @vm/maintenance-web; else mkdir -p apps/maintenance-web/dist; fi

# API, worker, platform and operator tools share one image; the command picks the role.
FROM ${NODE_IMAGE} AS server
RUN apk add --no-cache tini postgresql17-client
ENV NODE_ENV=production \
    MIGRATIONS_ROOT=/app/migrations \
    PLATFORM_MIGRATIONS_DIR=/app/migrations/platform \
    MAINTENANCE_MIGRATIONS_DIR=/app/migrations/maintenance
WORKDIR /app
COPY --from=build /src/dist/ /app/
RUN mkdir -p /var/lib/vm/blobs /var/lib/vm/identity /var/lib/vm/config /var/lib/vm/backups && chown -R node:node /var/lib/vm
USER node
ENTRYPOINT ["/sbin/tini", "--", "node"]
CMD ["maintenance-api/main.mjs"]

FROM ${NGINX_IMAGE} AS web
COPY deploy/private/nginx/default.conf.template /etc/nginx/templates/default.conf.template
COPY deploy/private/nginx/security-headers.conf /etc/nginx/snippets/security-headers.conf
COPY --from=build /src/apps/maintenance-web/dist/ /usr/share/nginx/html/
