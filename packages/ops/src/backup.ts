import { spawn } from 'node:child_process';
import { createHash, randomBytes } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { chmod, copyFile, mkdir, readdir, readFile, stat, writeFile } from 'node:fs/promises';
import path from 'node:path';
import pg from 'pg';
import { BUILD_VERSION } from '@vm/contracts';
import { recordBackup } from '@vm/core';

export const BACKUP_FORMAT = 1;
const MAINTENANCE_SCHEMAS = ['maintenance', 'integration'];
const PLATFORM_SCHEMAS = ['platform'];

export interface DatabaseTarget {
  name: 'platform' | 'maintenance' | 'combined';
  url: string;
  schemas: string[];
}

/** One dump when both products share a database, otherwise one per owner. */
export function databaseTargets(platformUrl: string, maintenanceUrl: string): DatabaseTarget[] {
  const norm = (u: string) => {
    const x = new URL(u);
    return `${x.hostname}:${x.port || '5432'}${x.pathname}`;
  };
  if (norm(platformUrl) === norm(maintenanceUrl)) return [{ name: 'combined', url: maintenanceUrl, schemas: [...PLATFORM_SCHEMAS, ...MAINTENANCE_SCHEMAS] }];
  return [
    { name: 'platform', url: platformUrl, schemas: PLATFORM_SCHEMAS },
    { name: 'maintenance', url: maintenanceUrl, schemas: MAINTENANCE_SCHEMAS },
  ];
}

export interface BackupFile {
  path: string;
  sha256: string;
  size: number;
}

export interface BackupManifest {
  format: number;
  backup_id: string;
  build_version: string;
  started_at: string;
  completed_at: string;
  installation_id: string | null;
  registry_id: string | null;
  databases: Array<{ name: DatabaseTarget['name']; schemas: string[]; dump: BackupFile; schema_versions: Record<string, string | null>; table_counts: Record<string, number> }>;
  blobs: { files: BackupFile[]; total_bytes: number };
  /** Attachments marked available whose bytes were missing or differed at backup time. */
  blob_problems: Array<{ storage_key: string; problem: 'missing' | 'hash_mismatch' }>;
  pending_outbox_events: number;
  /** Sensitive: identity signing key, system credentials, license public keys. Protect the backup accordingly. */
  config_files: Array<BackupFile & { name: string }>;
}

function connEnv(url: string): { args: string[]; env: NodeJS.ProcessEnv } {
  const u = new URL(url);
  const env: NodeJS.ProcessEnv = { ...process.env };
  if (u.password) env.PGPASSWORD = decodeURIComponent(u.password);
  u.password = '';
  return { args: [`--dbname=${u.toString()}`], env };
}

function run(cmd: string, args: string[], env: NodeJS.ProcessEnv): Promise<void> {
  return new Promise((resolve, reject) => {
    const child = spawn(cmd, args, { env, stdio: ['ignore', 'ignore', 'pipe'] });
    let stderr = '';
    child.stderr.on('data', (d) => (stderr += String(d)));
    child.on('error', reject);
    child.on('close', (code) => (code === 0 ? resolve() : reject(new Error(`${path.basename(cmd)} exited ${code}: ${stderr.trim()}`))));
  });
}

export async function sha256File(file: string): Promise<string> {
  const h = createHash('sha256');
  for await (const chunk of createReadStream(file)) h.update(chunk as Buffer);
  return h.digest('hex');
}

async function describe(root: string, file: string): Promise<BackupFile> {
  const full = path.join(root, file);
  return { path: file, sha256: await sha256File(full), size: (await stat(full)).size };
}

async function walk(dir: string, base = dir): Promise<string[]> {
  let entries;
  try {
    entries = await readdir(dir, { withFileTypes: true });
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return [];
    throw err;
  }
  const out: string[] = [];
  for (const e of entries) {
    const full = path.join(dir, e.name);
    if (e.isDirectory()) out.push(...(await walk(full, base)));
    else if (e.isFile() && !e.name.includes('.tmp-')) out.push(path.relative(base, full));
  }
  return out.sort();
}

async function tableCounts(client: pg.ClientBase, schemas: string[]): Promise<Record<string, number>> {
  const { rows } = await client.query<{ s: string; t: string }>(
    `SELECT table_schema AS s, table_name AS t FROM information_schema.tables
      WHERE table_schema = ANY($1::text[]) AND table_type = 'BASE TABLE' ORDER BY 1, 2`,
    [schemas],
  );
  const out: Record<string, number> = {};
  for (const r of rows) {
    const c = await client.query<{ n: string }>(`SELECT count(*) AS n FROM ${pg.escapeIdentifier(r.s)}.${pg.escapeIdentifier(r.t)}`);
    out[`${r.s}.${r.t}`] = Number(c.rows[0]!.n);
  }
  return out;
}

async function schemaVersions(client: pg.ClientBase, schemas: string[]): Promise<Record<string, string | null>> {
  const out: Record<string, string | null> = {};
  for (const s of schemas) {
    const exists = await client.query(`SELECT to_regclass($1) AS t`, [`${s}.schema_migrations`]);
    if (!exists.rows[0]?.t) {
      out[s] = null;
      continue;
    }
    const { rows } = await client.query<{ v: string | null }>(`SELECT max(version) AS v FROM ${pg.escapeIdentifier(s)}.schema_migrations`);
    out[s] = rows[0]?.v ?? null;
  }
  return out;
}

export interface BackupOptions {
  platformDatabaseUrl: string;
  maintenanceDatabaseUrl: string;
  blobRoot: string;
  outDir: string;
  /** Logical name to file path, e.g. { 'identity-signing-key.json': '/secrets/signing-key.json' }. */
  configFiles?: Record<string, string>;
  /** Directory holding pg_dump/pg_restore when they are not on PATH. */
  pgBinDir?: string;
}

/**
 * Creates a verifiable backup directory (docs/08 Backup and recovery). Each
 * database is dumped from an exported snapshot, so row counts in the manifest
 * describe exactly what the dump holds. Attachment bytes are copied after the
 * dump; bytes are written before their row is finalized, so every attachment
 * the dump marks available is present in the copy.
 */
export async function createBackup(o: BackupOptions): Promise<{ dir: string; manifest: BackupManifest }> {
  const startedAt = new Date();
  const backupId = `${startedAt.toISOString().replace(/[:.]/g, '-')}-${randomBytes(3).toString('hex')}`;
  const dir = path.join(o.outDir, backupId);
  await mkdir(path.join(dir, 'blobs'), { recursive: true, mode: 0o700 });
  const pgDump = o.pgBinDir ? path.join(o.pgBinDir, 'pg_dump') : 'pg_dump';

  const databases: BackupManifest['databases'] = [];
  let installationId: string | null = null;
  let registryId: string | null = null;
  let pendingOutbox = 0;
  const available = new Map<string, string>();

  for (const target of databaseTargets(o.platformDatabaseUrl, o.maintenanceDatabaseUrl)) {
    const client = new pg.Client({ connectionString: target.url });
    await client.connect();
    try {
      await client.query('BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY');
      const snap = (await client.query<{ s: string }>('SELECT pg_export_snapshot() AS s')).rows[0]!.s;
      const counts = await tableCounts(client, target.schemas);
      const versions = await schemaVersions(client, target.schemas);
      if (target.schemas.includes('maintenance')) {
        const inst = await client.query<{ v: string }>(`SELECT value #>> '{}' AS v FROM maintenance.installation_state WHERE key = 'installation_id'`);
        installationId = inst.rows[0]?.v ?? null;
        const ob = await client.query<{ n: string }>(`SELECT count(*) AS n FROM maintenance.outbox WHERE status = 'pending'`);
        pendingOutbox = Number(ob.rows[0]!.n);
        const att = await client.query<{ storage_key: string; sha256: string }>(`SELECT storage_key, sha256 FROM maintenance.attachment WHERE status = 'available'`);
        for (const a of att.rows) available.set(a.storage_key, a.sha256);
      }
      if (target.schemas.includes('platform')) {
        const reg = await client.query<{ registry_id: string }>(`SELECT registry_id FROM platform.installation`).catch(() => ({ rows: [] as Array<{ registry_id: string }> }));
        registryId = reg.rows[0]?.registry_id ?? null;
      }
      const dumpName = `${target.name}.dump`;
      const conn = connEnv(target.url);
      await run(pgDump, ['--format=custom', '--no-owner', '--no-privileges', `--snapshot=${snap}`, ...target.schemas.map((s) => `--schema=${s}`), `--file=${path.join(dir, dumpName)}`, ...conn.args], conn.env);
      await client.query('COMMIT');
      await chmod(path.join(dir, dumpName), 0o600);
      databases.push({ name: target.name, schemas: target.schemas, dump: await describe(dir, dumpName), schema_versions: versions, table_counts: counts });
    } finally {
      await client.end();
    }
  }

  const blobFiles: BackupFile[] = [];
  for (const rel of await walk(o.blobRoot)) {
    const dest = path.join(dir, 'blobs', rel);
    await mkdir(path.dirname(dest), { recursive: true });
    await copyFile(path.join(o.blobRoot, rel), dest);
    await chmod(dest, 0o600);
    blobFiles.push(await describe(path.join(dir, 'blobs'), rel));
  }
  const byKey = new Map(blobFiles.map((f) => [f.path.split(path.sep).join('/'), f.sha256]));
  const blobProblems: BackupManifest['blob_problems'] = [];
  for (const [key, sha] of available) {
    const got = byKey.get(key);
    if (!got) blobProblems.push({ storage_key: key, problem: 'missing' });
    else if (got !== sha) blobProblems.push({ storage_key: key, problem: 'hash_mismatch' });
  }

  const configFiles: BackupManifest['config_files'] = [];
  if (o.configFiles && Object.keys(o.configFiles).length > 0) {
    await mkdir(path.join(dir, 'config'), { mode: 0o700 });
    for (const [name, src] of Object.entries(o.configFiles)) {
      if (!/^[A-Za-z0-9._-]+$/.test(name)) throw new Error(`Invalid config file name ${name}`);
      try {
        await copyFile(src, path.join(dir, 'config', name));
        await chmod(path.join(dir, 'config', name), 0o600);
      } catch (err) {
        if ((err as NodeJS.ErrnoException).code === 'ENOENT') continue;
        throw err;
      }
      configFiles.push({ name, ...(await describe(path.join(dir, 'config'), name)) });
    }
  }

  const manifest: BackupManifest = {
    format: BACKUP_FORMAT,
    backup_id: backupId,
    build_version: BUILD_VERSION,
    started_at: startedAt.toISOString(),
    completed_at: new Date().toISOString(),
    installation_id: installationId,
    registry_id: registryId,
    databases,
    blobs: { files: blobFiles, total_bytes: blobFiles.reduce((n, f) => n + f.size, 0) },
    blob_problems: blobProblems,
    pending_outbox_events: pendingOutbox,
    config_files: configFiles,
  };
  await writeFile(path.join(dir, 'manifest.json'), JSON.stringify(manifest, null, 2), { mode: 0o600 });

  const mdb = new pg.Pool({ connectionString: o.maintenanceDatabaseUrl, max: 1 });
  try {
    await recordBackup(mdb, { backup_id: backupId, completed_at: manifest.completed_at, location: dir });
  } finally {
    await mdb.end();
  }
  return { dir, manifest };
}

export interface RestoreOptions {
  backupDir: string;
  platformDatabaseUrl: string;
  maintenanceDatabaseUrl: string;
  blobRoot: string;
  /** Logical config name to destination path; existing files are never overwritten. */
  configTargets?: Record<string, string>;
  pgBinDir?: string;
}

export interface RestoreReport {
  ok: boolean;
  backup_id: string;
  installation_id: string | null;
  registry_id: string | null;
  count_mismatches: Array<{ table: string; expected: number; actual: number }>;
  blobs_restored: number;
  blob_hash_failures: string[];
  config_restored: string[];
  pending_outbox_events: number;
}

export async function readManifest(backupDir: string): Promise<BackupManifest> {
  const m = JSON.parse(await readFile(path.join(backupDir, 'manifest.json'), 'utf8')) as BackupManifest;
  if (m.format !== BACKUP_FORMAT) throw new Error(`Unsupported backup format ${m.format}`);
  return m;
}

/** Re-hashes every file the manifest lists; run before restore and on a schedule against stored copies. */
export async function verifyBackup(backupDir: string): Promise<{ manifest: BackupManifest; failures: string[] }> {
  const manifest = await readManifest(backupDir);
  const failures: string[] = [];
  const check = async (root: string, f: BackupFile) => {
    try {
      if ((await sha256File(path.join(root, f.path))) !== f.sha256) failures.push(f.path);
    } catch {
      failures.push(f.path);
    }
  };
  for (const d of manifest.databases) await check(backupDir, d.dump);
  for (const f of manifest.blobs.files) await check(path.join(backupDir, 'blobs'), f);
  for (const f of manifest.config_files) await check(path.join(backupDir, 'config'), f);
  return { manifest, failures };
}

/**
 * Restores into empty databases and an empty blob root, then proves the
 * result against the manifest. Restoring over live data is refused: recovery
 * must not fork registry identity or merge two histories.
 */
export async function restoreBackup(o: RestoreOptions): Promise<RestoreReport> {
  const { manifest, failures } = await verifyBackup(o.backupDir);
  if (failures.length > 0) throw new Error(`Backup is damaged; files failing verification: ${failures.slice(0, 10).join(', ')}`);
  const targets = databaseTargets(o.platformDatabaseUrl, o.maintenanceDatabaseUrl);
  const layout = (xs: Array<{ schemas: string[] }>) => xs.map((x) => x.schemas.join('+')).sort().join(',');
  if (layout(targets) !== layout(manifest.databases)) {
    throw new Error(`Backup database layout (${layout(manifest.databases)}) differs from the target layout (${layout(targets)})`);
  }
  if ((await walk(o.blobRoot)).length > 0) throw new Error(`Blob root ${o.blobRoot} is not empty`);
  const pgRestore = o.pgBinDir ? path.join(o.pgBinDir, 'pg_restore') : 'pg_restore';

  const mismatches: RestoreReport['count_mismatches'] = [];
  for (const target of targets) {
    const entry = manifest.databases.find((d) => d.schemas.join('+') === target.schemas.join('+'))!;
    const client = new pg.Client({ connectionString: target.url });
    await client.connect();
    try {
      const present = await client.query<{ n: string }>(`SELECT nspname AS n FROM pg_namespace WHERE nspname = ANY($1::text[])`, [target.schemas]);
      if (present.rowCount) throw new Error(`Target database already contains schemas ${present.rows.map((r) => r.n).join(', ')}; restore requires an empty database`);
      const conn = connEnv(target.url);
      await run(pgRestore, ['--no-owner', '--no-privileges', '--exit-on-error', '--single-transaction', ...conn.args, path.join(o.backupDir, entry.dump.path)], conn.env);
      const counts = await tableCounts(client, target.schemas);
      for (const [table, expected] of Object.entries(entry.table_counts)) {
        const actual = counts[table] ?? -1;
        if (actual !== expected) mismatches.push({ table, expected, actual });
      }
      if (target.schemas.includes('maintenance')) {
        // Leases held by workers at backup time belong to processes that no longer exist.
        await client.query(`UPDATE maintenance.outbox SET lease_owner = NULL, lease_expires_at = NULL WHERE status = 'pending'`);
      }
    } finally {
      await client.end();
    }
  }

  const hashFailures: string[] = [];
  for (const f of manifest.blobs.files) {
    const dest = path.join(o.blobRoot, f.path);
    await mkdir(path.dirname(dest), { recursive: true });
    await copyFile(path.join(o.backupDir, 'blobs', f.path), dest);
    if ((await sha256File(dest)) !== f.sha256) hashFailures.push(f.path);
  }

  const restoredConfig: string[] = [];
  for (const f of manifest.config_files) {
    const dest = o.configTargets?.[f.name];
    if (!dest) continue;
    const exists = await stat(dest).then(() => true, () => false);
    if (exists) throw new Error(`Refusing to overwrite existing config file ${dest}`);
    await mkdir(path.dirname(dest), { recursive: true });
    await copyFile(path.join(o.backupDir, 'config', f.name), dest);
    await chmod(dest, 0o600);
    restoredConfig.push(f.name);
  }

  return {
    ok: mismatches.length === 0 && hashFailures.length === 0,
    backup_id: manifest.backup_id,
    installation_id: manifest.installation_id,
    registry_id: manifest.registry_id,
    count_mismatches: mismatches,
    blobs_restored: manifest.blobs.files.length,
    blob_hash_failures: hashFailures,
    config_restored: restoredConfig,
    pending_outbox_events: manifest.pending_outbox_events,
  };
}
