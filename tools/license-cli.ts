/**
 * License tooling. `keygen` and `sign` are issuer-side operations: the private
 * key must never be copied to a customer installation, which only receives the
 * public key file (LICENSE_PUBLIC_KEYS_FILE).
 *
 *   npm run license -- keygen --kid vendor-2026 --out-dir ./issuer-keys
 *   npm run license -- sign --private-key ./issuer-keys/vendor-2026.private.pem --kid vendor-2026 \
 *       --tenant-id <uuid> --installation-id <id> --features core,connected_operations \
 *       --starts 2026-11-01T00:00:00Z --ends 2027-11-01T00:00:00Z --grace-days 30 \
 *       [--sites 1] [--operational-users 20] [--assets 200] --policy-tag <tag> --out license.json
 *   npm run license -- verify --public-keys public-keys.json --file license.json --tenant-id <uuid> --installation-id <id>
 *
 * Grace days and limits have no built-in defaults: they are commercial terms.
 */
import { randomUUID } from 'node:crypto';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { parseArgs } from 'node:util';
import { FEATURES, PRODUCT_ID, type Feature, type LicenseDocument } from '@vm/contracts';
import { evaluateEntitlement, generateSigningKeyPair, signLicense, verifyLicense } from '@vm/licensing';
import { fail, print } from './lib/cli.ts';

const [command, ...rest] = process.argv.slice(2);

const opts = parseArgs({
  args: rest,
  options: {
    kid: { type: 'string' },
    'out-dir': { type: 'string' },
    'private-key': { type: 'string' },
    'public-keys': { type: 'string' },
    'tenant-id': { type: 'string' },
    'installation-id': { type: 'string' },
    features: { type: 'string' },
    starts: { type: 'string' },
    ends: { type: 'string' },
    'grace-days': { type: 'string' },
    sites: { type: 'string' },
    'operational-users': { type: 'string' },
    assets: { type: 'string' },
    'policy-tag': { type: 'string' },
    'license-id': { type: 'string' },
    file: { type: 'string' },
    out: { type: 'string' },
  },
}).values;

const need = (k: keyof typeof opts): string => (opts[k] as string | undefined) ?? fail(`--${k} is required`);
const limit = (k: 'sites' | 'operational-users' | 'assets'): number | null => {
  const v = opts[k];
  if (v === undefined) return null;
  const n = Number(v);
  if (!Number.isInteger(n) || n <= 0) fail(`--${k} must be a positive integer`);
  return n;
};

switch (command) {
  case 'keygen': {
    const kid = need('kid');
    const dir = need('out-dir');
    const { publicKeyPem, privateKeyPem } = generateSigningKeyPair();
    await mkdir(dir, { recursive: true, mode: 0o700 });
    const privFile = path.join(dir, `${kid}.private.pem`);
    await writeFile(privFile, privateKeyPem, { mode: 0o600, flag: 'wx' });
    const pubFile = path.join(dir, 'public-keys.json');
    let keys: Record<string, string> = {};
    try {
      keys = JSON.parse(await readFile(pubFile, 'utf8'));
    } catch {
      keys = {};
    }
    if (keys[kid]) fail(`key id ${kid} already present in ${pubFile}`);
    await writeFile(pubFile, JSON.stringify({ ...keys, [kid]: publicKeyPem }, null, 2));
    print({ private_key: privFile, public_keys: pubFile, kid });
    break;
  }
  case 'sign': {
    const features = need('features').split(',').map((f) => f.trim()) as Feature[];
    for (const f of features) if (!FEATURES.includes(f)) fail(`unknown feature ${f}; expected one of ${FEATURES.join(', ')}`);
    const graceDays = Number(need('grace-days'));
    const doc: LicenseDocument = {
      license_id: opts['license-id'] ?? `LIC-${randomUUID()}`,
      product: PRODUCT_ID,
      tenant_id: need('tenant-id'),
      installation_id: need('installation-id'),
      features,
      limits: { sites: limit('sites'), operational_users: limit('operational-users'), maintainable_assets: limit('assets') },
      term: { starts_at: need('starts'), ends_at: need('ends') },
      grace_days: graceDays,
      policy_tag: need('policy-tag'),
      issued_at: new Date().toISOString(),
      key_id: need('kid'),
    };
    const signed = signLicense(doc, await readFile(need('private-key'), 'utf8'));
    await writeFile(need('out'), JSON.stringify(signed, null, 2), { flag: 'wx' });
    print({ written: opts.out, license: signed.license });
    break;
  }
  case 'verify': {
    const keys = JSON.parse(await readFile(need('public-keys'), 'utf8')) as Record<string, string>;
    const doc = JSON.parse(await readFile(need('file'), 'utf8'));
    const v = verifyLicense(doc, keys, { tenantId: need('tenant-id'), installationId: need('installation-id') });
    if (!v.ok) fail(`license rejected: ${v.reason}`);
    const view = evaluateEntitlement({ license: v.license, verificationError: null, now: new Date(), lastSeenAt: null, usage: { sites: 0, operational_users: 0, maintainable_assets: 0 } });
    print({ ok: true, status: view.status, capabilities: view.capabilities, grace_ends_at: view.grace_ends_at, warnings: view.warnings });
    break;
  }
  default:
    fail('usage: license <keygen|sign|verify> [options]; see tools/license-cli.ts');
}
