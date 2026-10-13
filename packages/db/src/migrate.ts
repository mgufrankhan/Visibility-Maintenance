import { createHash } from 'node:crypto';
import { readdir, readFile } from 'node:fs/promises';
import path from 'node:path';
import type { Db, Queryable } from './pool.ts';

export interface MigrationResult {
  schema: string;
  applied: string[];
  current: string | null;
}

interface MigrationFile {
  version: string;
  file: string;
  sql: string;
  checksum: string;
}

async function loadMigrations(dir: string): Promise<MigrationFile[]> {
  const names = (await readdir(dir)).filter((n) => /^\d{4}_.+\.sql$/.test(n)).sort();
  return Promise.all(
    names.map(async (file) => {
      const sql = await readFile(path.join(dir, file), 'utf8');
      return {
        version: file.slice(0, 4),
        file,
        sql,
        checksum: createHash('sha256').update(sql).digest('hex'),
      };
    }),
  );
}

function lockKey(schema: string): number {
  return createHash('sha256').update(`vm-migrate:${schema}`).digest().readInt32BE(0);
}

/**
 * Applies the owner's migrations in order inside one advisory-locked session.
 * Each migration commits atomically with its schema_migrations row; a changed
 * checksum for an applied migration aborts the run.
 */
export async function migrate(db: Db, schema: string, dir: string): Promise<MigrationResult> {
  const files = await loadMigrations(dir);
  const client = await db.connect();
  const applied: string[] = [];
  try {
    await client.query('SELECT pg_advisory_lock($1)', [lockKey(schema)]);
    await client.query(`CREATE SCHEMA IF NOT EXISTS ${schema}`);
    await client.query(
      `CREATE TABLE IF NOT EXISTS ${schema}.schema_migrations (
         version text PRIMARY KEY,
         file text NOT NULL,
         checksum text NOT NULL,
         applied_at timestamptz NOT NULL DEFAULT now()
       )`,
    );
    const { rows } = await client.query<{ version: string; checksum: string }>(
      `SELECT version, checksum FROM ${schema}.schema_migrations`,
    );
    const done = new Map(rows.map((r) => [r.version, r.checksum]));
    for (const m of files) {
      const prior = done.get(m.version);
      if (prior) {
        if (prior !== m.checksum) {
          throw new Error(`Migration ${schema}/${m.file} was modified after being applied`);
        }
        continue;
      }
      await client.query('BEGIN');
      try {
        await client.query(m.sql);
        await client.query(
          `INSERT INTO ${schema}.schema_migrations (version, file, checksum) VALUES ($1, $2, $3)`,
          [m.version, m.file, m.checksum],
        );
        await client.query('COMMIT');
        applied.push(m.file);
      } catch (err) {
        await client.query('ROLLBACK');
        throw new Error(`Migration ${schema}/${m.file} failed: ${(err as Error).message}`);
      }
    }
    return { schema, applied, current: files.at(-1)?.version ?? null };
  } finally {
    await client.query('SELECT pg_advisory_unlock($1)', [lockKey(schema)]).catch(() => undefined);
    client.release();
  }
}

export interface SchemaStatus {
  schema: string;
  /** Migration files in this build not yet applied. */
  pending: string[];
  /** Applied versions this build does not know (the database is ahead of the code). */
  unknown: string[];
  /** Applied migrations whose file content changed after application. */
  modified: string[];
  current: string | null;
}

export async function schemaStatus(db: Queryable, schema: string, dir: string): Promise<SchemaStatus> {
  const files = await loadMigrations(dir);
  const exists = await db.query(`SELECT to_regclass($1) AS t`, [`${schema}.schema_migrations`]);
  if (!exists.rows[0]?.t) return { schema, pending: files.map((f) => f.file), unknown: [], modified: [], current: null };
  const { rows } = await db.query<{ version: string; checksum: string }>(`SELECT version, checksum FROM ${schema}.schema_migrations ORDER BY version`);
  const applied = new Map(rows.map((r) => [r.version, r.checksum]));
  const known = new Map(files.map((f) => [f.version, f]));
  return {
    schema,
    pending: files.filter((f) => !applied.has(f.version)).map((f) => f.file),
    unknown: rows.filter((r) => !known.has(r.version)).map((r) => r.version),
    modified: files.filter((f) => applied.has(f.version) && applied.get(f.version) !== f.checksum).map((f) => f.file),
    current: rows.at(-1)?.version ?? null,
  };
}

export async function pendingMigrations(db: Queryable, schema: string, dir: string): Promise<string[]> {
  return (await schemaStatus(db, schema, dir)).pending;
}

/**
 * Refuses to run a service against a schema that is behind its code (pending
 * migrations), ahead of it (applied migrations unknown to this build) or
 * migrated from different file content.
 */
export async function assertSchemaCompatible(db: Queryable, schema: string, dir: string): Promise<void> {
  const st = await schemaStatus(db, schema, dir);
  if (st.pending.length > 0) {
    throw new Error(`Schema ${schema} has pending migrations: ${st.pending.join(', ')}. Run migrations before starting.`);
  }
  if (st.unknown.length > 0) {
    throw new Error(`Schema ${schema} contains migrations newer than this build (${st.unknown.join(', ')}). Upgrade the service.`);
  }
  if (st.modified.length > 0) {
    throw new Error(`Schema ${schema} was migrated with different content for ${st.modified.join(', ')}.`);
  }
}
