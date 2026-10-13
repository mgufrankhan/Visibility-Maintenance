import { createHash } from 'node:crypto';
import type { PoolClient } from 'pg';
import { canonicalJson } from '@vm/contracts';
import { AppError, invalid } from './errors.ts';

export interface IdempotencyScope {
  tenantId: string;
  actorId: string;
  operation: string;
}

export interface IdempotentResult<T> {
  status: number;
  body: T;
  replayed: boolean;
}

export function payloadHash(payload: unknown): string {
  return createHash('sha256').update(canonicalJson(payload)).digest('hex');
}

/**
 * Runs `fn` at most once per (tenant, actor, operation, key) inside the caller's
 * transaction. A concurrent duplicate blocks on the key row until the first
 * commits, then replays the stored result. A different payload is a conflict.
 * Failed attempts roll back with the transaction and leave the key reusable.
 */
export async function runIdempotent<T>(
  tx: PoolClient,
  table: string,
  scope: IdempotencyScope,
  key: string | undefined,
  payload: unknown,
  fn: () => Promise<{ status: number; body: T }>,
): Promise<IdempotentResult<T>> {
  if (key === undefined || key === '') {
    const r = await fn();
    return { ...r, replayed: false };
  }
  if (key.length > 200) throw invalid('Idempotency-Key must be at most 200 characters');
  const hash = payloadHash(payload);
  const inserted = await tx.query(
    `INSERT INTO ${table} (tenant_id, actor_id, operation, key, payload_hash, status_code, response)
     VALUES ($1, $2, $3, $4, $5, 0, 'null'::jsonb)
     ON CONFLICT DO NOTHING
     RETURNING key`,
    [scope.tenantId, scope.actorId, scope.operation, key, hash],
  );
  if (inserted.rowCount === 0) {
    const { rows } = await tx.query<{ payload_hash: string; status_code: number; response: T }>(
      `SELECT payload_hash, status_code, response FROM ${table}
       WHERE tenant_id = $1 AND actor_id = $2 AND operation = $3 AND key = $4`,
      [scope.tenantId, scope.actorId, scope.operation, key],
    );
    const row = rows[0];
    if (!row) throw new AppError(409, 'idempotency_in_progress', 'A request with this Idempotency-Key is in progress');
    if (row.payload_hash !== hash) {
      throw new AppError(409, 'idempotency_key_reused', 'Idempotency-Key was already used with a different payload');
    }
    return { status: row.status_code, body: row.response, replayed: true };
  }
  const result = await fn();
  await tx.query(
    `UPDATE ${table} SET status_code = $5, response = $6::jsonb
     WHERE tenant_id = $1 AND actor_id = $2 AND operation = $3 AND key = $4`,
    [scope.tenantId, scope.actorId, scope.operation, key, result.status, JSON.stringify(result.body)],
  );
  return { ...result, replayed: false };
}
