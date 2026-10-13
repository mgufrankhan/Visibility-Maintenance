import { z } from 'zod';
import { uuid } from './common.ts';

export const STOCK_MOVEMENT_TYPES = ['receive', 'issue', 'return', 'adjust'] as const;
export type StockMovementType = (typeof STOCK_MOVEMENT_TYPES)[number];

export const createStoreRequest = z.object({
  site_id: uuid,
  code: z.string().min(1).max(40),
  name: z.string().min(1).max(200),
});

export const createPartRequest = z.object({
  sku: z.string().min(1).max(80),
  name: z.string().min(1).max(200),
  unit: z.string().min(1).max(30),
});

export const stockReceiveRequest = z.object({
  store_id: uuid,
  part_id: uuid,
  quantity: z.number().positive().max(1_000_000),
  unit_cost: z.number().nonnegative().max(1_000_000).nullable().default(null),
  currency: z.string().min(3).max(3).nullable().default(null),
  reason: z.string().min(1).max(500),
  idempotency_key: z.string().min(1).max(100).nullable().default(null),
});

export const stockIssueRequest = z.object({
  store_id: uuid,
  part_id: uuid,
  quantity: z.number().positive().max(1_000_000),
  work_order_id: uuid,
  reservation_id: uuid.nullable().default(null),
  reason: z.string().min(1).max(500).default('Issued to work order'),
  idempotency_key: z.string().min(1).max(100).nullable().default(null),
});

export const stockReturnRequest = z.object({
  store_id: uuid,
  part_id: uuid,
  quantity: z.number().positive().max(1_000_000),
  work_order_id: uuid,
  reason: z.string().min(1).max(500).default('Returned from work order'),
  idempotency_key: z.string().min(1).max(100).nullable().default(null),
});

export const stockAdjustRequest = z.object({
  store_id: uuid,
  part_id: uuid,
  /** Signed delta: positive increases on-hand, negative decreases. */
  quantity: z.number().refine((n) => n !== 0, 'quantity must be non-zero').max(1_000_000).min(-1_000_000),
  reason: z.string().min(3).max(500),
  idempotency_key: z.string().min(1).max(100).nullable().default(null),
});

export const stockReserveRequest = z.object({
  store_id: uuid,
  part_id: uuid,
  work_order_id: uuid,
  quantity: z.number().positive().max(1_000_000),
  idempotency_key: z.string().min(1).max(100).nullable().default(null),
});

export const WORK_ORDER_AUTHORITY_MODES = ['native', 'external_cmms'] as const;
export type WorkOrderAuthorityMode = (typeof WORK_ORDER_AUTHORITY_MODES)[number];

export const siteAuthorityRequest = z.object({
  site_id: uuid,
  work_order_mode: z.enum(WORK_ORDER_AUTHORITY_MODES),
  /** Field → owner. Example: { "state": "external", "title": "native" }. Unlisted fields stay native. */
  field_ownership: z.record(z.string().min(1).max(80), z.enum(['native', 'external'])).default({}),
  external_system: z.string().min(1).max(100).nullable().default(null),
});

export const cmmsExceptionResolveRequest = z.object({
  status: z.enum(['resolved', 'ignored']),
  resolution_note: z.string().min(1).max(1000),
});

export const AUTOMATION_KINDS = ['auto_draft_high_priority_request'] as const;
export type AutomationKind = (typeof AUTOMATION_KINDS)[number];

export const automationPolicyRequest = z.object({
  site_id: uuid,
  kind: z.enum(AUTOMATION_KINDS),
  enabled: z.boolean(),
  config: z
    .object({
      /** Hours after submit before a high-priority request becomes a draft WO. */
      delay_hours: z.number().int().min(1).max(168).default(4),
      team_id: uuid.nullable().default(null),
    })
    .default({ delay_hours: 4, team_id: null }),
});
