import type { Queryable } from '@vm/db';
import { invalid } from '@vm/server-kit';

export interface ExpectedPart {
  part_id: string;
  quantity: number;
}

/** Publishing requires each expected part to be active and carried at this site. */
export async function assertPartsStockedAtSite(db: Queryable, tenantId: string, siteId: string, parts: ExpectedPart[]): Promise<void> {
  const seen = new Set<string>();
  for (const line of parts) {
    if (seen.has(line.part_id)) throw invalid('Expected parts must be unique', { expected_parts: ['Duplicate part'] });
    seen.add(line.part_id);
    const { rows } = await db.query(
      `SELECT p.status,
              EXISTS (
                SELECT 1 FROM maintenance.inventory_balance b
                JOIN maintenance.store st ON st.id = b.store_id
               WHERE b.tenant_id = p.tenant_id AND b.part_id = p.id AND st.site_id = $2 AND st.status = 'active'
              ) AS stocked
         FROM maintenance.part p
        WHERE p.tenant_id = $1 AND p.id = $3`,
      [tenantId, siteId, line.part_id],
    );
    if (!rows[0] || rows[0].status !== 'active') throw invalid('Part is not active for this site', { expected_parts: ['Unknown part'] });
    if (!rows[0].stocked) throw invalid('Part is not stocked at this site', { expected_parts: ['Part is stocked at another site or not at all'] });
  }
}

/** Compares expected quantity with on-hand minus reserved at this site. Null means coverage is sufficient. */
export async function shortageText(db: Queryable, tenantId: string, siteId: string, parts: ExpectedPart[]): Promise<string | null> {
  const short: string[] = [];
  for (const line of parts) {
    const { rows } = await db.query(
      `SELECT p.sku,
              coalesce((
                SELECT sum(b.on_hand - b.reserved)
                  FROM maintenance.inventory_balance b
                  JOIN maintenance.store st ON st.id = b.store_id
                 WHERE b.tenant_id = p.tenant_id AND b.part_id = p.id AND st.site_id = $2 AND st.status = 'active'
              ), 0)::float AS available
         FROM maintenance.part p
        WHERE p.tenant_id = $1 AND p.id = $3`,
      [tenantId, siteId, line.part_id],
    );
    const available = Number(rows[0]?.available ?? 0);
    const sku = (rows[0]?.sku as string | undefined) ?? line.part_id;
    if (available < line.quantity) short.push(`${sku} needs ${line.quantity}, available ${available}`);
  }
  return short.length ? `Parts shortage: ${short.join('; ')}` : null;
}

export function expectedPartsOf(value: unknown): ExpectedPart[] {
  if (!Array.isArray(value)) return [];
  return value.flatMap((line) => {
    if (!line || typeof line !== 'object') return [];
    const partId = (line as { part_id?: unknown }).part_id;
    const quantity = Number((line as { quantity?: unknown }).quantity);
    if (typeof partId !== 'string' || !Number.isFinite(quantity)) return [];
    return [{ part_id: partId, quantity }];
  });
}
