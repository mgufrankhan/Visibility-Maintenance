import { randomUUID } from 'node:crypto';
import type { Queryable } from '@vm/db';
import { conflict, invalid } from '@vm/server-kit';
import { iso } from './records.ts';

export type SignatureOwner = 'work_order' | 'inspection_result';

export interface StoredSignature {
  id: string;
  signer_id: string;
  signed_at: string | null;
  snapshot_hash: string;
  amendment_reason: string | null;
}

export async function latestSignature(db: Queryable, tenantId: string, ownerType: SignatureOwner, ownerId: string, cycle: number): Promise<StoredSignature | null> {
  const { rows } = await db.query(
    `SELECT id, signer_id, signed_at, snapshot_hash, amendment_reason
       FROM maintenance.completion_signature
      WHERE tenant_id = $1 AND owner_type = $2 AND owner_id = $3 AND cycle = $4
      ORDER BY created_at DESC, id DESC LIMIT 1`,
    [tenantId, ownerType, ownerId, cycle],
  );
  const row = rows[0];
  if (!row) return null;
  return { id: row.id, signer_id: row.signer_id, signed_at: iso(row.signed_at), snapshot_hash: row.snapshot_hash, amendment_reason: row.amendment_reason };
}

export async function insertSignature(
  db: Queryable,
  input: {
    tenantId: string;
    siteId: string;
    ownerType: SignatureOwner;
    ownerId: string;
    cycle: number;
    signerId: string;
    signedAt: Date;
    snapshotHash: string;
    presentedHash: string;
    clientOpId: string | null;
    amendmentReason: string | null;
  },
): Promise<StoredSignature> {
  if (input.presentedHash !== input.snapshotHash) {
    throw conflict('snapshot_hash_mismatch', 'The signature does not match the issued procedure snapshot');
  }
  if (input.clientOpId) {
    const { rows } = await db.query(
      `SELECT id, signer_id, signed_at, snapshot_hash, amendment_reason FROM maintenance.completion_signature
        WHERE tenant_id = $1 AND signer_id = $2 AND client_op_id = $3`,
      [input.tenantId, input.signerId, input.clientOpId],
    );
    if (rows[0]) {
      return { id: rows[0].id, signer_id: rows[0].signer_id, signed_at: iso(rows[0].signed_at), snapshot_hash: rows[0].snapshot_hash, amendment_reason: rows[0].amendment_reason };
    }
  }
  const previous = await latestSignature(db, input.tenantId, input.ownerType, input.ownerId, input.cycle);
  if (previous && (!input.amendmentReason || input.amendmentReason.trim().length < 3)) {
    throw invalid('Replacing a signature requires a reason', { amendment_reason: ['Required'] });
  }
  const id = randomUUID();
  await db.query(
    `INSERT INTO maintenance.completion_signature
       (id, tenant_id, site_id, owner_type, owner_id, cycle, signer_id, signed_at, snapshot_hash, client_op_id, amends_signature_id, amendment_reason)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12)`,
    [
      id,
      input.tenantId,
      input.siteId,
      input.ownerType,
      input.ownerId,
      input.cycle,
      input.signerId,
      input.signedAt,
      input.snapshotHash,
      input.clientOpId,
      previous?.id ?? null,
      previous ? input.amendmentReason!.trim() : null,
    ],
  );
  return { id, signer_id: input.signerId, signed_at: input.signedAt.toISOString(), snapshot_hash: input.snapshotHash, amendment_reason: previous ? input.amendmentReason!.trim() : null };
}
