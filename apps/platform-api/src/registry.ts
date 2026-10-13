import { randomBytes, randomUUID } from 'node:crypto';
import type { FastifyInstance, FastifyRequest } from 'fastify';
import type { PoolClient } from 'pg';
import { withTransaction, type Db, type Queryable } from '@vm/db';
import {
  createAssetRequest,
  decodeCursor,
  encodeCursor,
  externalRefRequest,
  importRequest,
  lifecycleRequest,
  moveAssetRequest,
  pageQuery,
  updateAssetRequest,
  type AssetDto,
  type ImportDecision,
} from '@vm/contracts';
import { AppError, conflict, forbidden, invalid, notFound, parse, runIdempotent, staleVersion } from '@vm/server-kit';
import { z } from 'zod';
import { audit } from './audit.ts';
import { canEditAssets, canManageMappings, canReadSite, isTenantAdmin, type PlatformPrincipal } from './principal.ts';

export interface RegistryDeps {
  db: Db;
  authenticate: (req: FastifyRequest) => Promise<PlatformPrincipal>;
}

const ASSET_COLUMNS = `id, tenant_id, site_id, parent_id, code, name, asset_type, location, lifecycle, qr_token, version,
  change_seq, created_at, updated_at`;

function toDto(r: Record<string, unknown>): AssetDto {
  return {
    id: r.id as string,
    tenant_id: r.tenant_id as string,
    site_id: r.site_id as string,
    parent_id: (r.parent_id as string | null) ?? null,
    code: r.code as string,
    name: r.name as string,
    asset_type: r.asset_type as string,
    location: (r.location as string | null) ?? null,
    lifecycle: r.lifecycle as AssetDto['lifecycle'],
    qr_token: r.qr_token as string,
    version: r.version as number,
    change_seq: String(r.change_seq),
    created_at: (r.created_at as Date).toISOString(),
    updated_at: (r.updated_at as Date).toISOString(),
  };
}

async function tenantSites(db: Queryable, tenantId: string): Promise<string[]> {
  const { rows } = await db.query<{ id: string }>(`SELECT id FROM platform.site WHERE tenant_id = $1`, [tenantId]);
  return rows.map((r) => r.id);
}

async function readable(db: Queryable, p: PlatformPrincipal): Promise<string[]> {
  return isTenantAdmin(p) ? tenantSites(db, p.tenantId) : p.siteIds;
}

async function lockAsset(tx: PoolClient, p: PlatformPrincipal, id: string): Promise<Record<string, unknown>> {
  const { rows } = await tx.query(`SELECT * FROM platform.asset WHERE tenant_id = $1 AND id::text = $2 FOR UPDATE`, [p.tenantId, id]);
  const row = rows[0];
  if (!row || !canReadSite(p, row.site_id)) throw notFound('Asset');
  return row;
}

async function assertNoCycle(db: Queryable, tenantId: string, assetId: string, parentId: string): Promise<void> {
  const { rows } = await db.query(
    `WITH RECURSIVE up(id, parent_id, depth) AS (
       SELECT id, parent_id, 0 FROM platform.asset WHERE tenant_id = $1 AND id = $2
       UNION ALL
       SELECT a.id, a.parent_id, up.depth + 1 FROM platform.asset a JOIN up ON a.id = up.parent_id
        WHERE a.tenant_id = $1 AND up.depth < 100)
     SELECT 1 FROM up WHERE id = $3 LIMIT 1`,
    [tenantId, parentId, assetId],
  );
  if (rows.length > 0) throw invalid('Asset hierarchy cannot contain a cycle', { parent_id: ['Parent is a descendant of this asset'] });
}

async function recordHistory(tx: Queryable, p: PlatformPrincipal, row: Record<string, unknown>, kind: string, reason: string | null): Promise<void> {
  await tx.query(
    `INSERT INTO platform.asset_history (tenant_id, asset_id, version, change_kind, snapshot, reason, changed_by)
     VALUES ($1,$2,$3,$4,$5,$6,$7)`,
    [p.tenantId, row.id, row.version, kind, JSON.stringify(toDto(row)), reason, p.userId],
  );
}

function ifMatchVersion(req: FastifyRequest): number {
  const h = req.headers['if-match'];
  const raw = typeof h === 'string' ? h.replace(/^W\//, '').replace(/"/g, '') : undefined;
  const v = Number(raw);
  if (!raw || !Number.isInteger(v) || v < 1) throw new AppError(428, 'precondition_required', 'If-Match with the record version is required');
  return v;
}

export function registerRegistryRoutes(app: FastifyInstance, deps: RegistryDeps): void {
  const { db } = deps;

  app.get('/api/v1/assets', async (req) => {
    const p = await deps.authenticate(req);
    const q = parse(
      pageQuery.extend({
        site_id: z.uuid().optional(),
        lifecycle: z.enum(['active', 'archived', 'tombstoned']).optional(),
        q: z.string().max(100).optional(),
        ids: z.string().max(20000).optional(),
      }),
      req.query,
    );
    const sites = await readable(db, p);
    const scope = q.site_id ? sites.filter((s) => s === q.site_id) : sites;
    if (scope.length === 0) return { items: [], next_cursor: null };
    const params: unknown[] = [p.tenantId, scope];
    const where = ['tenant_id = $1', 'site_id = ANY($2::uuid[])'];
    if (q.lifecycle) where.push(`lifecycle = $${params.push(q.lifecycle)}`);
    if (q.q) where.push(`(name ILIKE $${params.push(`%${q.q}%`)} OR code ILIKE $${params.length})`);
    if (q.ids) {
      const ids = q.ids.split(',').filter((s) => z.uuid().safeParse(s).success);
      where.push(`id = ANY($${params.push(ids)}::uuid[])`);
    }
    const cursor = decodeCursor(q.cursor);
    if (cursor) where.push(`(code, id) > ($${params.push(cursor[0])}, $${params.push(cursor[1])}::uuid)`);
    const { rows } = await db.query(
      `SELECT ${ASSET_COLUMNS} FROM platform.asset WHERE ${where.join(' AND ')} ORDER BY code, id LIMIT ${q.limit + 1}`,
      params,
    );
    const items = rows.slice(0, q.limit).map(toDto);
    const last = items.at(-1);
    return { items, next_cursor: rows.length > q.limit && last ? encodeCursor(last.code, last.id) : null };
  });

  /** Change feed used by product services to refresh identity snapshots (MA-03). */
  app.get('/api/v1/assets/changes', async (req) => {
    const p = await deps.authenticate(req);
    const q = parse(z.object({ after_seq: z.coerce.bigint().default(0n), limit: z.coerce.number().int().min(1).max(500).default(200) }), req.query);
    const sites = await readable(db, p);
    const { rows } = await db.query(
      `SELECT ${ASSET_COLUMNS} FROM platform.asset WHERE tenant_id = $1 AND site_id = ANY($2::uuid[]) AND change_seq > $3
        ORDER BY change_seq LIMIT $4`,
      [p.tenantId, sites, q.after_seq.toString(), q.limit],
    );
    const items = rows.map(toDto);
    return { items, last_seq: items.at(-1)?.change_seq ?? q.after_seq.toString() };
  });

  app.get('/api/v1/assets/resolve-qr/:token', async (req) => {
    const p = await deps.authenticate(req);
    const { token } = req.params as { token: string };
    const { rows } = await db.query(
      `SELECT ${ASSET_COLUMNS} FROM platform.asset a
        WHERE a.tenant_id = $1 AND (a.qr_token = $2 OR a.id = (
          SELECT asset_id FROM platform.asset_alias WHERE tenant_id = $1 AND kind = 'qr' AND value = $2))`,
      [p.tenantId, token],
    );
    const row = rows[0];
    if (!row || !canReadSite(p, row.site_id)) throw notFound('Asset');
    return toDto(row);
  });

  app.get('/api/v1/assets/:id', async (req) => {
    const p = await deps.authenticate(req);
    const { id } = req.params as { id: string };
    if (!z.uuid().safeParse(id).success) throw notFound('Asset');
    let { rows } = await db.query(`SELECT ${ASSET_COLUMNS} FROM platform.asset WHERE tenant_id = $1 AND id = $2`, [p.tenantId, id]);
    let resolvedFromAlias: string | null = null;
    if (!rows[0]) {
      ({ rows } = await db.query(
        `SELECT ${ASSET_COLUMNS} FROM platform.asset WHERE tenant_id = $1 AND id = (
           SELECT asset_id FROM platform.asset_alias WHERE tenant_id = $1 AND kind = 'id' AND value = $2)`,
        [p.tenantId, id],
      ));
      resolvedFromAlias = rows[0] ? id : null;
    }
    const row = rows[0];
    if (!row || !canReadSite(p, row.site_id)) throw notFound('Asset');
    return { ...toDto(row), resolved_from_alias: resolvedFromAlias };
  });

  app.get('/api/v1/assets/:id/history', async (req) => {
    const p = await deps.authenticate(req);
    const { id } = req.params as { id: string };
    const { rows: a } = await db.query(`SELECT site_id FROM platform.asset WHERE tenant_id = $1 AND id::text = $2`, [p.tenantId, id]);
    if (!a[0] || !canReadSite(p, a[0].site_id)) throw notFound('Asset');
    const { rows } = await db.query(
      `SELECT version, change_kind, snapshot, reason, changed_by, changed_at FROM platform.asset_history
        WHERE tenant_id = $1 AND asset_id = $2 ORDER BY version`,
      [p.tenantId, id],
    );
    return { items: rows, next_cursor: null };
  });

  app.post('/api/v1/assets', async (req, reply) => {
    const p = await deps.authenticate(req);
    const body = parse(createAssetRequest, req.body);
    if (!canEditAssets(p, body.site_id)) throw forbidden('Registry asset permission required for this site');
    const key = req.headers['idempotency-key'] as string | undefined;
    const result = await withTransaction(db, (tx) =>
      runIdempotent(tx, 'platform.idempotency_key', { tenantId: p.tenantId, actorId: p.userId, operation: 'asset.create' }, key, body, async () => {
        const { rowCount } = await tx.query(`SELECT 1 FROM platform.site WHERE tenant_id = $1 AND id = $2 AND status = 'active'`, [p.tenantId, body.site_id]);
        if (!rowCount) throw notFound('Site');
        if (body.parent_id) {
          const { rows } = await tx.query(`SELECT site_id FROM platform.asset WHERE tenant_id = $1 AND id = $2`, [p.tenantId, body.parent_id]);
          if (!rows[0] || !canReadSite(p, rows[0].site_id)) throw invalid('Parent asset not found', { parent_id: ['Unknown parent'] });
        }
        const id = randomUUID();
        try {
          const { rows } = await tx.query(
            `INSERT INTO platform.asset (id, tenant_id, site_id, parent_id, code, name, asset_type, location, qr_token, created_by, updated_by)
             VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$10) RETURNING *`,
            [id, p.tenantId, body.site_id, body.parent_id, body.code, body.name, body.asset_type, body.location, randomBytes(18).toString('base64url'), p.userId],
          );
          await recordHistory(tx, p, rows[0], 'created', null);
          await audit(tx, { tenantId: p.tenantId, siteId: body.site_id, actorId: p.userId, action: 'asset.created', targetType: 'asset', targetId: id, afterVersion: 1, correlationId: req.correlationId });
          return { status: 201, body: toDto(rows[0]) };
        } catch (err) {
          if ((err as { code?: string }).code === '23505') throw conflict('duplicate_asset_code', 'An asset with this code already exists at the site');
          throw err;
        }
      }),
    );
    return reply.status(result.status).send(result.body);
  });

  app.patch('/api/v1/assets/:id', async (req) => {
    const p = await deps.authenticate(req);
    const { id } = req.params as { id: string };
    const expected = ifMatchVersion(req);
    const patch = parse(updateAssetRequest, req.body);
    return withTransaction(db, async (tx) => {
      const row = await lockAsset(tx, p, id);
      if (!canEditAssets(p, row.site_id as string)) throw forbidden('Registry asset permission required for this site');
      if (row.version !== expected) throw staleVersion(row.version as number);
      if (row.lifecycle === 'tombstoned') throw conflict('asset_tombstoned', 'Tombstoned assets cannot be edited');
      if (patch.parent_id) await assertNoCycle(tx, p.tenantId, id, patch.parent_id);
      const merged = { ...row, ...patch };
      try {
        const { rows } = await tx.query(
          `UPDATE platform.asset SET code = $3, name = $4, asset_type = $5, location = $6, parent_id = $7,
             version = version + 1, change_seq = nextval('platform.asset_change_seq'), updated_at = now(), updated_by = $8
           WHERE tenant_id = $1 AND id = $2 RETURNING *`,
          [p.tenantId, id, merged.code, merged.name, merged.asset_type, merged.location, merged.parent_id, p.userId],
        );
        await recordHistory(tx, p, rows[0], 'updated', null);
        await audit(tx, { tenantId: p.tenantId, siteId: row.site_id as string, actorId: p.userId, action: 'asset.updated', targetType: 'asset', targetId: id, beforeVersion: expected, afterVersion: expected + 1, detail: { fields: Object.keys(patch) }, correlationId: req.correlationId });
        return toDto(rows[0]);
      } catch (err) {
        if ((err as { code?: string }).code === '23505') throw conflict('duplicate_asset_code', 'An asset with this code already exists at the site');
        throw err;
      }
    });
  });

  const lifecycleRoute = (action: 'archive' | 'reactivate', from: string, to: string) =>
    app.post(`/api/v1/assets/:id/${action}`, async (req) => {
      const p = await deps.authenticate(req);
      const { id } = req.params as { id: string };
      const expected = ifMatchVersion(req);
      const body = parse(lifecycleRequest, req.body);
      return withTransaction(db, async (tx) => {
        const row = await lockAsset(tx, p, id);
        if (!canEditAssets(p, row.site_id as string)) throw forbidden('Registry asset permission required for this site');
        if (row.version !== expected) throw staleVersion(row.version as number);
        if (row.lifecycle !== from) throw conflict('invalid_lifecycle', `Asset must be ${from} to ${action}`);
        const { rows } = await tx.query(
          `UPDATE platform.asset SET lifecycle = $3, version = version + 1, change_seq = nextval('platform.asset_change_seq'),
             updated_at = now(), updated_by = $4 WHERE tenant_id = $1 AND id = $2 RETURNING *`,
          [p.tenantId, id, to, p.userId],
        );
        await recordHistory(tx, p, rows[0], action === 'archive' ? 'archived' : 'reactivated', body.reason);
        await audit(tx, { tenantId: p.tenantId, siteId: row.site_id as string, actorId: p.userId, action: `asset.${action}d`, targetType: 'asset', targetId: id, beforeVersion: expected, afterVersion: expected + 1, reason: body.reason, correlationId: req.correlationId });
        return toDto(rows[0]);
      });
    });
  lifecycleRoute('archive', 'active', 'archived');
  lifecycleRoute('reactivate', 'archived', 'active');

  app.post('/api/v1/assets/:id/move', async (req) => {
    const p = await deps.authenticate(req);
    const { id } = req.params as { id: string };
    const expected = ifMatchVersion(req);
    const body = parse(moveAssetRequest, req.body);
    return withTransaction(db, async (tx) => {
      const row = await lockAsset(tx, p, id);
      if (!canEditAssets(p, row.site_id as string) || !canEditAssets(p, body.site_id)) {
        throw forbidden('Registry asset permission is required at both the current and target site');
      }
      if (row.version !== expected) throw staleVersion(row.version as number);
      if (row.site_id === body.site_id) throw invalid('Asset is already at this site');
      const { rowCount } = await tx.query(`SELECT 1 FROM platform.site WHERE tenant_id = $1 AND id = $2 AND status = 'active'`, [p.tenantId, body.site_id]);
      if (!rowCount) throw notFound('Site');
      try {
        const { rows } = await tx.query(
          `UPDATE platform.asset SET site_id = $3, parent_id = NULL, version = version + 1,
             change_seq = nextval('platform.asset_change_seq'), updated_at = now(), updated_by = $4
           WHERE tenant_id = $1 AND id = $2 RETURNING *`,
          [p.tenantId, id, body.site_id, p.userId],
        );
        await recordHistory(tx, p, rows[0], 'moved', body.reason);
        await audit(tx, { tenantId: p.tenantId, siteId: body.site_id, actorId: p.userId, action: 'asset.moved', targetType: 'asset', targetId: id, beforeVersion: expected, afterVersion: expected + 1, reason: body.reason, detail: { from_site_id: row.site_id, to_site_id: body.site_id }, correlationId: req.correlationId });
        return toDto(rows[0]);
      } catch (err) {
        if ((err as { code?: string }).code === '23505') throw conflict('duplicate_asset_code', 'The target site already has an asset with this code');
        throw err;
      }
    });
  });

  // ----- External identity references (owned by the registry) -----
  app.get('/api/v1/assets/:id/external-refs', async (req) => {
    const p = await deps.authenticate(req);
    const { id } = req.params as { id: string };
    const { rows: a } = await db.query(`SELECT site_id FROM platform.asset WHERE tenant_id = $1 AND id::text = $2`, [p.tenantId, id]);
    if (!a[0] || !canReadSite(p, a[0].site_id)) throw notFound('Asset');
    const { rows } = await db.query(
      `SELECT id, asset_id, provider, provider_instance, external_id, status FROM platform.external_asset_ref
        WHERE tenant_id = $1 AND asset_id = $2 ORDER BY provider, external_id`,
      [p.tenantId, id],
    );
    return { items: rows, next_cursor: null };
  });

  app.get('/api/v1/assets/external-refs/lookup', async (req) => {
    const p = await deps.authenticate(req);
    const q = parse(externalRefRequest, req.query);
    const { rows } = await db.query(
      `SELECT r.id, r.asset_id, r.provider, r.provider_instance, r.external_id, r.status, a.site_id
         FROM platform.external_asset_ref r JOIN platform.asset a ON a.id = r.asset_id
        WHERE r.tenant_id = $1 AND r.provider = $2 AND r.provider_instance = $3 AND r.external_id = $4 AND r.status = 'active'`,
      [p.tenantId, q.provider, q.provider_instance, q.external_id],
    );
    const row = rows[0];
    if (!row || !canReadSite(p, row.site_id)) throw notFound('External reference');
    return row;
  });

  app.post('/api/v1/assets/:id/external-refs', async (req, reply) => {
    const p = await deps.authenticate(req);
    const { id } = req.params as { id: string };
    const body = parse(externalRefRequest, req.body);
    const ref = await withTransaction(db, async (tx) => {
      const row = await lockAsset(tx, p, id);
      if (!canManageMappings(p, row.site_id as string)) throw forbidden('Registry mapping permission required');
      const refId = randomUUID();
      try {
        const { rows } = await tx.query(
          `INSERT INTO platform.external_asset_ref (id, tenant_id, asset_id, provider, provider_instance, external_id, created_by)
           VALUES ($1,$2,$3,$4,$5,$6,$7) RETURNING id, asset_id, provider, provider_instance, external_id, status`,
          [refId, p.tenantId, id, body.provider, body.provider_instance, body.external_id, p.userId],
        );
        await audit(tx, { tenantId: p.tenantId, siteId: row.site_id as string, actorId: p.userId, action: 'external_ref.created', targetType: 'asset', targetId: id, detail: body, correlationId: req.correlationId });
        return rows[0];
      } catch (err) {
        if ((err as { code?: string }).code === '23505') throw conflict('external_ref_in_use', 'This external reference is already mapped to an asset');
        throw err;
      }
    });
    return reply.status(201).send(ref);
  });

  app.post('/api/v1/assets/external-refs/:refId/archive', async (req) => {
    const p = await deps.authenticate(req);
    const { refId } = req.params as { refId: string };
    return withTransaction(db, async (tx) => {
      const { rows } = await tx.query(
        `SELECT r.*, a.site_id FROM platform.external_asset_ref r JOIN platform.asset a ON a.id = r.asset_id
          WHERE r.tenant_id = $1 AND r.id::text = $2 FOR UPDATE OF r`,
        [p.tenantId, refId],
      );
      const row = rows[0];
      if (!row || !canReadSite(p, row.site_id)) throw notFound('External reference');
      if (!canManageMappings(p, row.site_id)) throw forbidden('Registry mapping permission required');
      await tx.query(`UPDATE platform.external_asset_ref SET status = 'archived', updated_at = now() WHERE id = $1`, [row.id]);
      await audit(tx, { tenantId: p.tenantId, siteId: row.site_id, actorId: p.userId, action: 'external_ref.archived', targetType: 'asset', targetId: row.asset_id, detail: { ref_id: row.id }, correlationId: req.correlationId });
      return { ...row, status: 'archived' };
    });
  });

  // ----- Bulk import: resolve existing identities, never merge by name -----
  async function planImport(tx: Queryable, p: PlatformPrincipal, rows: z.infer<typeof importRequest>['rows']): Promise<ImportDecision[]> {
    const decisions: ImportDecision[] = [];
    const seen = new Map<string, number>();
    for (const [i, r] of rows.entries()) {
      const errors: string[] = [];
      if (!canEditAssets(p, r.site_id)) errors.push('No registry asset permission for this site');
      const dupKey = `${r.site_id}/${r.code.toLowerCase()}`;
      if (seen.has(dupKey)) errors.push(`Duplicate code in import (row ${seen.get(dupKey)})`);
      seen.set(dupKey, i);
      if (errors.length) {
        decisions.push({ row: i, action: 'error', errors });
        continue;
      }
      if (r.existing_asset_id) {
        const { rows: a } = await tx.query(`SELECT id, site_id FROM platform.asset WHERE tenant_id = $1 AND id = $2`, [p.tenantId, r.existing_asset_id]);
        if (!a[0] || !canReadSite(p, a[0].site_id)) decisions.push({ row: i, action: 'error', errors: ['existing_asset_id not found'] });
        else decisions.push({ row: i, action: 'link', asset_id: a[0].id, reason: 'explicit existing_asset_id' });
        continue;
      }
      const candidates = new Set<string>();
      const { rows: byCode } = await tx.query(`SELECT id FROM platform.asset WHERE tenant_id = $1 AND site_id = $2 AND lower(code) = lower($3)`, [p.tenantId, r.site_id, r.code]);
      byCode.forEach((c) => candidates.add(c.id));
      if (r.external_ref) {
        const { rows: byRef } = await tx.query(
          `SELECT asset_id FROM platform.external_asset_ref WHERE tenant_id = $1 AND provider = $2 AND provider_instance = $3 AND external_id = $4 AND status = 'active'`,
          [p.tenantId, r.external_ref.provider, r.external_ref.provider_instance, r.external_ref.external_id],
        );
        byRef.forEach((c) => candidates.add(c.asset_id));
      }
      if (candidates.size === 0) {
        const { rows: byName } = await tx.query(`SELECT id FROM platform.asset WHERE tenant_id = $1 AND site_id = $2 AND lower(name) = lower($3)`, [p.tenantId, r.site_id, r.name]);
        if (byName.length > 0) {
          decisions.push({ row: i, action: 'ambiguous', candidates: byName.map((c) => c.id), reason: 'Same name exists with a different code; confirm with existing_asset_id or a distinct code' });
        } else decisions.push({ row: i, action: 'create' });
      } else if (candidates.size === 1) {
        decisions.push({ row: i, action: 'link', asset_id: [...candidates][0]!, reason: 'matched code or external reference' });
      } else {
        decisions.push({ row: i, action: 'ambiguous', candidates: [...candidates], reason: 'Code and external reference resolve to different assets' });
      }
    }
    return decisions;
  }

  app.post('/api/v1/assets/import/preview', async (req) => {
    const p = await deps.authenticate(req);
    const body = parse(importRequest, req.body);
    return { decisions: await planImport(db, p, body.rows) };
  });

  app.post('/api/v1/assets/import/commit', async (req) => {
    const p = await deps.authenticate(req);
    const body = parse(importRequest, req.body);
    const key = req.headers['idempotency-key'] as string | undefined;
    const result = await withTransaction(db, (tx) =>
      runIdempotent(tx, 'platform.idempotency_key', { tenantId: p.tenantId, actorId: p.userId, operation: 'asset.import' }, key, body, async () => {
        const decisions = await planImport(tx, p, body.rows);
        const blocked = decisions.filter((d) => d.action === 'error' || d.action === 'ambiguous');
        if (blocked.length > 0) {
          throw new AppError(409, 'import_requires_review', `${blocked.length} rows need review before commit`);
        }
        const outcome: Array<{ row: number; asset_id: string; action: 'created' | 'linked' }> = [];
        for (const d of decisions) {
          const r = body.rows[d.row]!;
          let assetId: string;
          if (d.action === 'create') {
            assetId = randomUUID();
            const { rows } = await tx.query(
              `INSERT INTO platform.asset (id, tenant_id, site_id, code, name, asset_type, location, qr_token, created_by, updated_by)
               VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$9) RETURNING *`,
              [assetId, p.tenantId, r.site_id, r.code, r.name, r.asset_type, r.location, randomBytes(18).toString('base64url'), p.userId],
            );
            await recordHistory(tx, p, rows[0], 'imported', null);
            outcome.push({ row: d.row, asset_id: assetId, action: 'created' });
          } else if (d.action === 'link') {
            assetId = d.asset_id;
            outcome.push({ row: d.row, asset_id: assetId, action: 'linked' });
          } else continue;
          if (r.external_ref) {
            await tx.query(
              `INSERT INTO platform.external_asset_ref (id, tenant_id, asset_id, provider, provider_instance, external_id, created_by)
               VALUES ($1,$2,$3,$4,$5,$6,$7) ON CONFLICT DO NOTHING`,
              [randomUUID(), p.tenantId, assetId, r.external_ref.provider, r.external_ref.provider_instance, r.external_ref.external_id, p.userId],
            );
          }
        }
        await audit(tx, { tenantId: p.tenantId, actorId: p.userId, action: 'asset.imported', targetType: 'import', targetId: key ?? randomUUID(), detail: { created: outcome.filter((o) => o.action === 'created').length, linked: outcome.filter((o) => o.action === 'linked').length }, correlationId: req.correlationId });
        return { status: 200, body: { results: outcome } };
      }),
    );
    return result.body;
  });
}
