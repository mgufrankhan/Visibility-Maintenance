import { randomUUID } from 'node:crypto';
import type {
  createPartRequest,
  createStoreRequest,
  stockAdjustRequest,
  stockIssueRequest,
  stockReceiveRequest,
  stockReserveRequest,
  stockReturnRequest,
} from '@vm/contracts';
import { withTransaction, type Queryable } from '@vm/db';
import { can } from '@vm/policy';
import { conflict, invalid, notFound } from '@vm/server-kit';
import type { z } from 'zod';
import { requirePermission, requireVisible } from './access.ts';
import type { Actor, Services } from './context.ts';
import { writeAudit } from './records.ts';

type StoreInput = z.infer<typeof createStoreRequest>;
type PartInput = z.infer<typeof createPartRequest>;

async function loadStore(db: Queryable, tenantId: string, storeId: string) {
  const { rows } = await db.query(`SELECT * FROM maintenance.store WHERE tenant_id = $1 AND id::text = $2`, [tenantId, storeId]);
  if (!rows[0]) throw notFound('Store');
  return rows[0] as { id: string; site_id: string; code: string; name: string; status: string; unit?: string };
}

async function loadPart(db: Queryable, tenantId: string, partId: string) {
  const { rows } = await db.query(`SELECT * FROM maintenance.part WHERE tenant_id = $1 AND id::text = $2`, [tenantId, partId]);
  if (!rows[0]) throw notFound('Part');
  return rows[0] as { id: string; sku: string; name: string; unit: string; status: string };
}

async function loadWorkOrderSite(db: Queryable, tenantId: string, woId: string) {
  const { rows } = await db.query(`SELECT id, site_id, state FROM maintenance.work_order WHERE tenant_id = $1 AND id::text = $2`, [tenantId, woId]);
  if (!rows[0]) throw notFound('Work order');
  return rows[0] as { id: string; site_id: string; state: string };
}

function storeDto(r: Record<string, any>) {
  return { id: r.id, site_id: r.site_id, code: r.code, name: r.name, status: r.status, version: r.version };
}

function partDto(r: Record<string, any>) {
  return { id: r.id, sku: r.sku, name: r.name, unit: r.unit, status: r.status, version: r.version };
}

function balanceDto(r: Record<string, any>) {
  return {
    store_id: r.store_id,
    part_id: r.part_id,
    on_hand: Number(r.on_hand),
    reserved: Number(r.reserved),
    available: Number(r.on_hand) - Number(r.reserved),
  };
}

function movementDto(r: Record<string, any>) {
  return {
    id: r.id,
    site_id: r.site_id,
    store_id: r.store_id,
    part_id: r.part_id,
    movement_type: r.movement_type,
    quantity: Number(r.quantity),
    unit: r.unit,
    unit_cost: r.unit_cost === null ? null : Number(r.unit_cost),
    currency: r.currency,
    reason: r.reason,
    work_order_id: r.work_order_id,
    reservation_id: r.reservation_id,
    created_at: new Date(r.created_at).toISOString(),
    created_by: r.created_by,
  };
}

export async function listStores(s: Services, actor: Actor, siteId?: string) {
  const p = actor.principal;
  if (siteId) requireVisible(p, 'maintenance.stores.view', siteId, 'Store');
  const sites = (siteId ? [siteId] : p.memberSiteIds).filter((id) => can(p, 'maintenance.stores.view', id));
  if (!sites.length) return [];
  const { rows } = await s.db.query(
    `SELECT * FROM maintenance.store WHERE tenant_id = $1 AND site_id = ANY($2::uuid[]) AND status = 'active' ORDER BY code`,
    [p.tenantId, sites],
  );
  return rows.map(storeDto);
}

export async function createStore(s: Services, actor: Actor, input: StoreInput) {
  const p = actor.principal;
  requirePermission(p, 'maintenance.stores.manage', input.site_id);
  await s.entitlements.require(p.tenantId, 'core.create_work');
  return withTransaction(s.db, async (tx) => {
    const id = randomUUID();
    try {
      const { rows } = await tx.query(
        `INSERT INTO maintenance.store (id, tenant_id, site_id, code, name, created_by) VALUES ($1,$2,$3,$4,$5,$6) RETURNING *`,
        [id, p.tenantId, input.site_id, input.code, input.name, p.userId],
      );
      await writeAudit(tx, actor, { siteId: input.site_id, action: 'store.created', targetType: 'store', targetId: id });
      return storeDto(rows[0]);
    } catch (err) {
      if ((err as { code?: string }).code === '23505') throw conflict('duplicate_store_code', 'A store with this code already exists at the site');
      throw err;
    }
  });
}

export async function listParts(s: Services, actor: Actor) {
  const p = actor.principal;
  const allowed = p.memberSiteIds.some((id) => can(p, 'maintenance.stores.view', id));
  if (!allowed) return [];
  const { rows } = await s.db.query(`SELECT * FROM maintenance.part WHERE tenant_id = $1 AND status = 'active' ORDER BY sku`, [p.tenantId]);
  return rows.map(partDto);
}

export async function createPart(s: Services, actor: Actor, input: PartInput) {
  const p = actor.principal;
  const site = p.memberSiteIds.find((id) => can(p, 'maintenance.stores.manage', id));
  if (!site) throw notFound('Site');
  requirePermission(p, 'maintenance.stores.manage', site);
  await s.entitlements.require(p.tenantId, 'core.create_work');
  return withTransaction(s.db, async (tx) => {
    const id = randomUUID();
    try {
      const { rows } = await tx.query(
        `INSERT INTO maintenance.part (id, tenant_id, sku, name, unit, created_by) VALUES ($1,$2,$3,$4,$5,$6) RETURNING *`,
        [id, p.tenantId, input.sku, input.name, input.unit, p.userId],
      );
      await writeAudit(tx, actor, { siteId: site, action: 'part.created', targetType: 'part', targetId: id });
      return partDto(rows[0]);
    } catch (err) {
      if ((err as { code?: string }).code === '23505') throw conflict('duplicate_sku', 'A part with this SKU already exists');
      throw err;
    }
  });
}

export async function listBalances(s: Services, actor: Actor, storeId: string) {
  const store = await loadStore(s.db, actor.principal.tenantId, storeId);
  requireVisible(actor.principal, 'maintenance.stores.view', store.site_id, 'Store');
  const { rows } = await s.db.query(
    `SELECT b.*, p.sku, p.name AS part_name, p.unit FROM maintenance.inventory_balance b
       JOIN maintenance.part p ON p.id = b.part_id
      WHERE b.tenant_id = $1 AND b.store_id = $2 ORDER BY p.sku`,
    [actor.principal.tenantId, storeId],
  );
  return rows.map((r) => ({ ...balanceDto(r), sku: r.sku, part_name: r.part_name, unit: r.unit }));
}

async function ensureBalance(tx: Queryable, tenantId: string, storeId: string, partId: string) {
  await tx.query(
    `INSERT INTO maintenance.inventory_balance (tenant_id, store_id, part_id) VALUES ($1,$2,$3) ON CONFLICT DO NOTHING`,
    [tenantId, storeId, partId],
  );
  const { rows } = await tx.query(
    `SELECT * FROM maintenance.inventory_balance WHERE tenant_id = $1 AND store_id = $2 AND part_id = $3 FOR UPDATE`,
    [tenantId, storeId, partId],
  );
  return rows[0] as { on_hand: string; reserved: string };
}

async function replayMovement(tx: Queryable, tenantId: string, userId: string, type: string, key: string | null) {
  if (!key) return null;
  const { rows } = await tx.query(
    `SELECT * FROM maintenance.stock_movement WHERE tenant_id = $1 AND created_by = $2 AND movement_type = $3 AND idempotency_key = $4`,
    [tenantId, userId, type, key],
  );
  return rows[0] ?? null;
}

export async function receiveStock(s: Services, actor: Actor, input: z.infer<typeof stockReceiveRequest>) {
  const p = actor.principal;
  const store = await loadStore(s.db, p.tenantId, input.store_id);
  const part = await loadPart(s.db, p.tenantId, input.part_id);
  requirePermission(p, 'maintenance.stores.move', store.site_id);
  await s.entitlements.require(p.tenantId, 'core.create_work');
  return withTransaction(s.db, async (tx) => {
    const prior = await replayMovement(tx, p.tenantId, p.userId, 'receive', input.idempotency_key);
    if (prior) return { ...movementDto(prior), replayed: true };
    const bal = await ensureBalance(tx, p.tenantId, store.id, part.id);
    const next = Number(bal.on_hand) + input.quantity;
    await tx.query(`UPDATE maintenance.inventory_balance SET on_hand = $4, updated_at = now() WHERE tenant_id = $1 AND store_id = $2 AND part_id = $3`, [
      p.tenantId,
      store.id,
      part.id,
      next,
    ]);
    const id = randomUUID();
    const { rows } = await tx.query(
      `INSERT INTO maintenance.stock_movement
         (id, tenant_id, site_id, store_id, part_id, movement_type, quantity, unit, unit_cost, currency, reason, idempotency_key, created_by)
       VALUES ($1,$2,$3,$4,$5,'receive',$6,$7,$8,$9,$10,$11,$12) RETURNING *`,
      [id, p.tenantId, store.site_id, store.id, part.id, input.quantity, part.unit, input.unit_cost, input.currency, input.reason, input.idempotency_key, p.userId],
    );
    await writeAudit(tx, actor, { siteId: store.site_id, action: 'stock.received', targetType: 'stock_movement', targetId: id, detail: { quantity: input.quantity } });
    return { ...movementDto(rows[0]), replayed: false };
  });
}

export async function issueStock(s: Services, actor: Actor, input: z.infer<typeof stockIssueRequest>) {
  const p = actor.principal;
  const store = await loadStore(s.db, p.tenantId, input.store_id);
  const part = await loadPart(s.db, p.tenantId, input.part_id);
  const wo = await loadWorkOrderSite(s.db, p.tenantId, input.work_order_id);
  if (wo.site_id !== store.site_id) throw invalid('Work order must belong to the store site', { work_order_id: ['Site mismatch'] });
  requirePermission(p, 'maintenance.stores.move', store.site_id);
  await s.entitlements.require(p.tenantId, 'core.create_work');
  return withTransaction(s.db, async (tx) => {
    const prior = await replayMovement(tx, p.tenantId, p.userId, 'issue', input.idempotency_key);
    if (prior) return { ...movementDto(prior), replayed: true };
    const bal = await ensureBalance(tx, p.tenantId, store.id, part.id);
    const onHand = Number(bal.on_hand);
    const reserved = Number(bal.reserved);
    const available = onHand - reserved;
    if (input.reservation_id) {
      const { rows: res } = await tx.query(
        `SELECT * FROM maintenance.stock_reservation WHERE tenant_id = $1 AND id = $2 AND status = 'active' FOR UPDATE`,
        [p.tenantId, input.reservation_id],
      );
      if (!res[0]) throw invalid('Reservation not found', { reservation_id: ['Unknown or inactive'] });
      if (res[0].store_id !== store.id || res[0].part_id !== part.id || res[0].work_order_id !== wo.id) {
        throw invalid('Reservation does not match issue', { reservation_id: ['Mismatch'] });
      }
      if (Number(res[0].quantity) < input.quantity) throw invalid('Issue exceeds reservation', { quantity: ['Too large'] });
      await tx.query(`UPDATE maintenance.stock_reservation SET status = 'consumed' WHERE id = $1`, [res[0].id]);
      await tx.query(
        `UPDATE maintenance.inventory_balance SET on_hand = $4, reserved = $5, updated_at = now() WHERE tenant_id = $1 AND store_id = $2 AND part_id = $3`,
        [p.tenantId, store.id, part.id, onHand - input.quantity, reserved - Number(res[0].quantity)],
      );
    } else {
      if (available < input.quantity) throw invalid('Insufficient available stock', { quantity: [`Available ${available}`] });
      await tx.query(`UPDATE maintenance.inventory_balance SET on_hand = $4, updated_at = now() WHERE tenant_id = $1 AND store_id = $2 AND part_id = $3`, [
        p.tenantId,
        store.id,
        part.id,
        onHand - input.quantity,
      ]);
    }
    const id = randomUUID();
    const { rows } = await tx.query(
      `INSERT INTO maintenance.stock_movement
         (id, tenant_id, site_id, store_id, part_id, movement_type, quantity, unit, reason, work_order_id, reservation_id, idempotency_key, created_by)
       VALUES ($1,$2,$3,$4,$5,'issue',$6,$7,$8,$9,$10,$11,$12) RETURNING *`,
      [id, p.tenantId, store.site_id, store.id, part.id, -input.quantity, part.unit, input.reason, wo.id, input.reservation_id, input.idempotency_key, p.userId],
    );
    await writeAudit(tx, actor, { siteId: store.site_id, action: 'stock.issued', targetType: 'stock_movement', targetId: id, detail: { work_order_id: wo.id } });
    return { ...movementDto(rows[0]), replayed: false };
  });
}

export async function returnStock(s: Services, actor: Actor, input: z.infer<typeof stockReturnRequest>) {
  const p = actor.principal;
  const store = await loadStore(s.db, p.tenantId, input.store_id);
  const part = await loadPart(s.db, p.tenantId, input.part_id);
  const wo = await loadWorkOrderSite(s.db, p.tenantId, input.work_order_id);
  if (wo.site_id !== store.site_id) throw invalid('Work order must belong to the store site', { work_order_id: ['Site mismatch'] });
  requirePermission(p, 'maintenance.stores.move', store.site_id);
  return withTransaction(s.db, async (tx) => {
    const prior = await replayMovement(tx, p.tenantId, p.userId, 'return', input.idempotency_key);
    if (prior) return { ...movementDto(prior), replayed: true };
    const { rows: issued } = await tx.query(
      `SELECT coalesce(sum(-quantity),0)::float8 AS qty FROM maintenance.stock_movement
        WHERE tenant_id = $1 AND work_order_id = $2 AND part_id = $3 AND store_id = $4 AND movement_type = 'issue'`,
      [p.tenantId, wo.id, part.id, store.id],
    );
    const { rows: returned } = await tx.query(
      `SELECT coalesce(sum(quantity),0)::float8 AS qty FROM maintenance.stock_movement
        WHERE tenant_id = $1 AND work_order_id = $2 AND part_id = $3 AND store_id = $4 AND movement_type = 'return'`,
      [p.tenantId, wo.id, part.id, store.id],
    );
    const netIssued = Number(issued[0].qty) - Number(returned[0].qty);
    if (input.quantity > netIssued) throw invalid('Return exceeds net issued quantity', { quantity: [`Net issued ${netIssued}`] });
    const bal = await ensureBalance(tx, p.tenantId, store.id, part.id);
    await tx.query(`UPDATE maintenance.inventory_balance SET on_hand = $4, updated_at = now() WHERE tenant_id = $1 AND store_id = $2 AND part_id = $3`, [
      p.tenantId,
      store.id,
      part.id,
      Number(bal.on_hand) + input.quantity,
    ]);
    const id = randomUUID();
    const { rows } = await tx.query(
      `INSERT INTO maintenance.stock_movement
         (id, tenant_id, site_id, store_id, part_id, movement_type, quantity, unit, reason, work_order_id, idempotency_key, created_by)
       VALUES ($1,$2,$3,$4,$5,'return',$6,$7,$8,$9,$10,$11) RETURNING *`,
      [id, p.tenantId, store.site_id, store.id, part.id, input.quantity, part.unit, input.reason, wo.id, input.idempotency_key, p.userId],
    );
    await writeAudit(tx, actor, { siteId: store.site_id, action: 'stock.returned', targetType: 'stock_movement', targetId: id });
    return { ...movementDto(rows[0]), replayed: false };
  });
}

export async function adjustStock(s: Services, actor: Actor, input: z.infer<typeof stockAdjustRequest>) {
  const p = actor.principal;
  const store = await loadStore(s.db, p.tenantId, input.store_id);
  const part = await loadPart(s.db, p.tenantId, input.part_id);
  requirePermission(p, 'maintenance.stores.move', store.site_id);
  return withTransaction(s.db, async (tx) => {
    const prior = await replayMovement(tx, p.tenantId, p.userId, 'adjust', input.idempotency_key);
    if (prior) return { ...movementDto(prior), replayed: true };
    const bal = await ensureBalance(tx, p.tenantId, store.id, part.id);
    const next = Number(bal.on_hand) + input.quantity;
    if (next < Number(bal.reserved)) throw invalid('Adjustment would drop on-hand below reserved', { quantity: ['Too low'] });
    if (next < 0) throw invalid('Negative stock is blocked', { quantity: ['Would go negative'] });
    await tx.query(`UPDATE maintenance.inventory_balance SET on_hand = $4, updated_at = now() WHERE tenant_id = $1 AND store_id = $2 AND part_id = $3`, [
      p.tenantId,
      store.id,
      part.id,
      next,
    ]);
    const id = randomUUID();
    const { rows } = await tx.query(
      `INSERT INTO maintenance.stock_movement
         (id, tenant_id, site_id, store_id, part_id, movement_type, quantity, unit, reason, idempotency_key, created_by)
       VALUES ($1,$2,$3,$4,$5,'adjust',$6,$7,$8,$9,$10) RETURNING *`,
      [id, p.tenantId, store.site_id, store.id, part.id, input.quantity, part.unit, input.reason, input.idempotency_key, p.userId],
    );
    await writeAudit(tx, actor, { siteId: store.site_id, action: 'stock.adjusted', targetType: 'stock_movement', targetId: id, reason: input.reason });
    return { ...movementDto(rows[0]), replayed: false };
  });
}

export async function reserveStock(s: Services, actor: Actor, input: z.infer<typeof stockReserveRequest>) {
  const p = actor.principal;
  const store = await loadStore(s.db, p.tenantId, input.store_id);
  const part = await loadPart(s.db, p.tenantId, input.part_id);
  const wo = await loadWorkOrderSite(s.db, p.tenantId, input.work_order_id);
  if (wo.site_id !== store.site_id) throw invalid('Work order must belong to the store site', { work_order_id: ['Site mismatch'] });
  requirePermission(p, 'maintenance.stores.reserve', store.site_id);
  return withTransaction(s.db, async (tx) => {
    if (input.idempotency_key) {
      const { rows } = await tx.query(
        `SELECT * FROM maintenance.stock_reservation WHERE tenant_id = $1 AND created_by = $2 AND idempotency_key = $3`,
        [p.tenantId, p.userId, input.idempotency_key],
      );
      if (rows[0]) {
        return {
          id: rows[0].id,
          store_id: rows[0].store_id,
          part_id: rows[0].part_id,
          work_order_id: rows[0].work_order_id,
          quantity: Number(rows[0].quantity),
          status: rows[0].status,
          replayed: true,
        };
      }
    }
    const bal = await ensureBalance(tx, p.tenantId, store.id, part.id);
    const available = Number(bal.on_hand) - Number(bal.reserved);
    if (available < input.quantity) throw invalid('Insufficient available stock to reserve', { quantity: [`Available ${available}`] });
    await tx.query(`UPDATE maintenance.inventory_balance SET reserved = $4, updated_at = now() WHERE tenant_id = $1 AND store_id = $2 AND part_id = $3`, [
      p.tenantId,
      store.id,
      part.id,
      Number(bal.reserved) + input.quantity,
    ]);
    const id = randomUUID();
    await tx.query(
      `INSERT INTO maintenance.stock_reservation
         (id, tenant_id, site_id, store_id, part_id, work_order_id, quantity, idempotency_key, created_by)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)`,
      [id, p.tenantId, store.site_id, store.id, part.id, wo.id, input.quantity, input.idempotency_key, p.userId],
    );
    await writeAudit(tx, actor, { siteId: store.site_id, action: 'stock.reserved', targetType: 'stock_reservation', targetId: id });
    return { id, store_id: store.id, part_id: part.id, work_order_id: wo.id, quantity: input.quantity, status: 'active', replayed: false };
  });
}

export async function listMovements(s: Services, actor: Actor, q: { store_id?: string; work_order_id?: string; limit?: number }) {
  const p = actor.principal;
  const limit = q.limit ?? 50;
  if (q.store_id) {
    const store = await loadStore(s.db, p.tenantId, q.store_id);
    requireVisible(p, 'maintenance.stores.view', store.site_id, 'Store');
    const { rows } = await s.db.query(
      `SELECT * FROM maintenance.stock_movement WHERE tenant_id = $1 AND store_id = $2 ORDER BY created_at DESC LIMIT $3`,
      [p.tenantId, q.store_id, limit],
    );
    return rows.map(movementDto);
  }
  if (q.work_order_id) {
    const wo = await loadWorkOrderSite(s.db, p.tenantId, q.work_order_id);
    requireVisible(p, ['maintenance.stores.view', 'maintenance.view'], wo.site_id, 'Work order');
    const { rows } = await s.db.query(
      `SELECT * FROM maintenance.stock_movement WHERE tenant_id = $1 AND work_order_id = $2 ORDER BY created_at DESC LIMIT $3`,
      [p.tenantId, q.work_order_id, limit],
    );
    return rows.map(movementDto);
  }
  throw invalid('store_id or work_order_id is required', { store_id: ['Required'] });
}
