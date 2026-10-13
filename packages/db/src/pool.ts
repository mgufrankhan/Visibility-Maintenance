import pg from 'pg';

// Return NUMERIC as string (exact decimals) and BIGINT as string; timestamps stay Date objects.
pg.types.setTypeParser(pg.types.builtins.NUMERIC, (v) => v);
pg.types.setTypeParser(pg.types.builtins.INT8, (v) => v);

export type Db = pg.Pool;
export type Queryable = pg.Pool | pg.PoolClient;

export function createPool(connectionString: string, opts: { max?: number; applicationName?: string } = {}): Db {
  const pool = new pg.Pool({
    connectionString,
    max: opts.max ?? 10,
    application_name: opts.applicationName ?? 'visibility-maintenance',
  });
  pool.on('error', () => {
    // Idle client errors are surfaced by the next query; keep the process alive.
  });
  return pool;
}

export async function withTransaction<T>(db: Db, fn: (tx: pg.PoolClient) => Promise<T>): Promise<T> {
  const client = await db.connect();
  try {
    await client.query('BEGIN');
    const result = await fn(client);
    await client.query('COMMIT');
    return result;
  } catch (err) {
    await client.query('ROLLBACK').catch(() => undefined);
    throw err;
  } finally {
    client.release();
  }
}
