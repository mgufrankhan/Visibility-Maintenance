/**
 * Local development stack: migrate, then run platform + API + worker + web.
 *
 *   npm run dev
 *
 * Requires local PostgreSQL (TEST_DATABASE_ADMIN_URL, default
 * postgres://localhost:5432/postgres). State lives under .dev/ (gitignored).
 * Ports match apps/maintenance-web Vite proxies: platform 5191, API 5192, web 5173.
 */
import { randomBytes } from 'node:crypto';
import { spawn, type ChildProcess } from 'node:child_process';
import { access, mkdir, readFile, writeFile } from 'node:fs/promises';
import { createServer } from 'node:net';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import pg from 'pg';
import { createPool } from '@vm/db';
import { generateSigningKeyPair } from '@vm/licensing';
import { migrateAll, migrationDirs, setupTenant } from '@vm/ops';
import { HttpRegistryClient } from '@vm/registry';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const DEV_DIR = path.join(ROOT, '.dev');
const DB_NAME = process.env.VM_DEV_DATABASE ?? 'vm_dev';
const ADMIN_URL = process.env.TEST_DATABASE_ADMIN_URL ?? 'postgres://localhost:5432/postgres';
const PLATFORM_PORT = Number(process.env.PLATFORM_PORT ?? 5191);
const API_PORT = Number(process.env.API_PORT ?? 5192);
const WEB_PORT = Number(process.env.WEB_PORT ?? 5173);

const children: ChildProcess[] = [];
let shuttingDown = false;

function log(msg: string): void {
  console.log(`[dev] ${msg}`);
}

function fail(msg: string): never {
  console.error(`[dev] ${msg}`);
  process.exit(1);
}

async function exists(file: string): Promise<boolean> {
  try {
    await access(file);
    return true;
  } catch {
    return false;
  }
}

async function ensurePortFree(port: number, label: string): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    const server = createServer();
    server.once('error', (err: NodeJS.ErrnoException) => {
      if (err.code === 'EADDRINUSE') reject(new Error(`${label} port ${port} is already in use`));
      else reject(err);
    });
    server.listen(port, '127.0.0.1', () => {
      server.close(() => resolve());
    });
  });
}

async function ensureDatabase(): Promise<void> {
  const admin = new pg.Client({ connectionString: ADMIN_URL });
  try {
    await admin.connect();
  } catch (err) {
    fail(`cannot connect to PostgreSQL at ${ADMIN_URL}: ${(err as Error).message}`);
  }
  const found = await admin.query('SELECT 1 FROM pg_database WHERE datname = $1', [DB_NAME]);
  if (found.rowCount === 0) {
    log(`creating database ${DB_NAME}`);
    await admin.query(`CREATE DATABASE ${DB_NAME}`);
  }
  await admin.end();
}

async function readOrCreateSecret(file: string): Promise<string> {
  if (await exists(file)) return (await readFile(file, 'utf8')).trim();
  const value = randomBytes(32).toString('hex');
  await mkdir(path.dirname(file), { recursive: true });
  await writeFile(file, value, { mode: 0o600 });
  return value;
}

/** Local issuer keypair for importing Core licenses during development. */
async function ensureIssuerKeys(issuerDir: string): Promise<string> {
  const kid = 'dev-issuer';
  const pubFile = path.join(issuerDir, 'public-keys.json');
  const privFile = path.join(issuerDir, `${kid}.private.pem`);
  if (!(await exists(pubFile)) || !(await exists(privFile))) {
    log('creating local license issuer keys');
    await mkdir(issuerDir, { recursive: true, mode: 0o700 });
    const { publicKeyPem, privateKeyPem } = generateSigningKeyPair();
    await writeFile(privFile, privateKeyPem, { mode: 0o600 });
    await writeFile(pubFile, JSON.stringify({ [kid]: publicKeyPem }, null, 2));
  }
  return pubFile;
}

async function waitHttp(url: string, timeoutMs = 30_000): Promise<void> {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    try {
      const res = await fetch(url);
      if (res.ok) return;
    } catch {
      /* retry */
    }
    await new Promise((r) => setTimeout(r, 200));
  }
  fail(`timed out waiting for ${url}`);
}

function spawnService(name: string, command: string, args: string[], env: NodeJS.ProcessEnv): ChildProcess {
  const child = spawn(command, args, {
    cwd: ROOT,
    env,
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  children.push(child);
  const prefix = (chunk: Buffer) => {
    const text = chunk.toString();
    for (const line of text.split(/\r?\n/)) {
      if (line.length) console.log(`[${name}] ${line}`);
    }
  };
  child.stdout?.on('data', prefix);
  child.stderr?.on('data', prefix);
  child.on('exit', (code, signal) => {
    if (!shuttingDown) {
      console.error(`[dev] ${name} exited (code=${code}, signal=${signal}); shutting down`);
      shutdown(code ?? 1);
    }
  });
  return child;
}

function shutdown(code = 0): void {
  if (shuttingDown) return;
  shuttingDown = true;
  for (const child of children) {
    try {
      child.kill('SIGTERM');
    } catch {
      /* ignore */
    }
  }
  setTimeout(() => process.exit(code), 500).unref();
}

async function main(): Promise<void> {
  await mkdir(DEV_DIR, { recursive: true });
  const identityDir = path.join(DEV_DIR, 'identity');
  const configDir = path.join(DEV_DIR, 'config');
  const blobRoot = path.join(DEV_DIR, 'blobs');
  await mkdir(identityDir, { recursive: true });
  await mkdir(configDir, { recursive: true });
  await mkdir(blobRoot, { recursive: true });

  const signingKeyFile = path.join(identityDir, 'signing-key.json');
  const credentialsFile = path.join(configDir, 'system-credentials.json');
  const secretFile = path.join(DEV_DIR, 'download-link-secret');
  const downloadLinkSecret = await readOrCreateSecret(secretFile);
  const licensePublicKeysFile = await ensureIssuerKeys(path.join(DEV_DIR, 'issuer'));

  const base = new URL(ADMIN_URL);
  base.pathname = `/${DB_NAME}`;
  const databaseUrl = base.toString();

  try {
    await ensurePortFree(PLATFORM_PORT, 'platform');
    await ensurePortFree(API_PORT, 'maintenance API');
    await ensurePortFree(WEB_PORT, 'web');
  } catch (err) {
    fail(`${(err as Error).message}. Stop the other process or set PLATFORM_PORT / API_PORT / WEB_PORT.`);
  }

  await ensureDatabase();
  log(`migrating ${DB_NAME}`);
  const pool = createPool(databaseUrl, { max: 2, applicationName: 'vm-dev-migrate' });
  try {
    await migrateAll({ platform: pool, maintenance: pool }, migrationDirs());
  } finally {
    await pool.end();
  }

  const platformUrl = `http://127.0.0.1:${PLATFORM_PORT}`;
  const commonEnv: NodeJS.ProcessEnv = {
    ...process.env,
    NODE_ENV: 'development',
    HOST: '127.0.0.1',
    PLATFORM_DATABASE_URL: databaseUrl,
    MAINTENANCE_DATABASE_URL: databaseUrl,
    PLATFORM_ISSUER: platformUrl,
    PLATFORM_URL: platformUrl,
    TOKEN_ISSUER: platformUrl,
    PLATFORM_SIGNING_KEY_FILE: signingKeyFile,
    BLOB_ROOT: blobRoot,
    DOWNLOAD_LINK_SECRET: downloadLinkSecret,
    SYSTEM_CREDENTIALS_FILE: credentialsFile,
    LICENSE_PUBLIC_KEYS_FILE: licensePublicKeysFile,
    PLATFORM_MIGRATIONS_DIR: path.join(ROOT, 'database/migrations/platform'),
    MAINTENANCE_MIGRATIONS_DIR: path.join(ROOT, 'database/migrations/maintenance'),
    ALLOW_SIMULATED_CONNECTORS: process.env.ALLOW_SIMULATED_CONNECTORS ?? 'true',
    NEO_INFERENCE_POLICY: process.env.NEO_INFERENCE_POLICY ?? 'private_only',
  };

  log(`starting platform on ${platformUrl}`);
  spawnService('platform', 'npx', ['tsx', 'watch', 'apps/platform-api/src/main.ts'], { ...commonEnv, PORT: String(PLATFORM_PORT) });
  await waitHttp(`${platformUrl}/health/ready`);

  if (!(await exists(credentialsFile))) {
    log('first run: creating local tenant (dev / Plant 1)');
    const setupPool = createPool(databaseUrl, { max: 2, applicationName: 'vm-dev-setup' });
    try {
      const result = await setupTenant(
        { platform: setupPool, maintenance: setupPool },
        new HttpRegistryClient({ baseUrl: platformUrl }),
        {
          tenant: { slug: 'dev', name: 'Local Dev' },
          site: { code: 'P1', name: 'Plant 1', timezone: process.env.VM_DEV_TIMEZONE ?? 'UTC' },
          admin: {
            email: process.env.VM_DEV_ADMIN_EMAIL ?? 'admin@dev.local',
            displayName: 'Dev Admin',
            password: process.env.VM_DEV_ADMIN_PASSWORD ?? 'dev-admin-password',
          },
          systemCredentialsFile: credentialsFile,
        },
      );
      log(`tenant ${result.tenant_id} site ${result.site_id}`);
      log(`login tenant=dev email=admin@dev.local password=${process.env.VM_DEV_ADMIN_PASSWORD ?? 'dev-admin-password'}`);
    } finally {
      await setupPool.end();
    }
  } else {
    log(`using existing credentials at ${credentialsFile}`);
  }

  log(`starting maintenance API on http://127.0.0.1:${API_PORT}`);
  spawnService('api', 'npx', ['tsx', 'watch', 'apps/maintenance-api/src/main.ts'], { ...commonEnv, PORT: String(API_PORT) });
  spawnService('worker', 'npx', ['tsx', 'watch', 'apps/maintenance-worker/src/main.ts'], { ...commonEnv, WORKER_ID: 'dev-worker' });
  await waitHttp(`http://127.0.0.1:${API_PORT}/health/ready`);

  log(`starting web on http://127.0.0.1:${WEB_PORT}`);
  spawnService('web', 'npm', ['run', 'dev', '-w', '@vm/maintenance-web', '--', '--host', '127.0.0.1', '--port', String(WEB_PORT), '--strictPort'], commonEnv);

  console.log('');
  log(`ready — open http://127.0.0.1:${WEB_PORT}`);
  log(`platform ${platformUrl}  api http://127.0.0.1:${API_PORT}`);
  log('Ctrl+C to stop');
}

for (const sig of ['SIGINT', 'SIGTERM'] as const) {
  process.on(sig, () => shutdown(0));
}

main().catch((err) => {
  console.error(err);
  shutdown(1);
});
