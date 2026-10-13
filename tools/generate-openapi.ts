/**
 * Emit OpenAPI 3.1 and business-event JSON Schemas from Zod contracts (docs/03).
 * Run: NODE_ENV=development npx tsx tools/generate-openapi.ts
 */
import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { z } from 'zod';
import {
  BUILD_VERSION,
  createRequestRequest,
  triageRequest,
  createWorkOrderRequest,
  patchWorkOrderRequest,
  transitionRequest,
  laborEntryRequest,
  evidenceRequest,
  createPlanRequest,
  planRevisionRequest,
  planStatusRequest,
  createInspectionTemplateRequest,
  startInspectionRequest,
  submitInspectionRequest,
  createDowntimeRequest,
  amendDowntimeRequest,
  upsertProfileRequest,
  createTeamRequest,
  roleAssignmentRequest,
  siteSettingsRequest,
  neoAskRequest,
  recommendationDecisionRequest,
  normalizedEvent,
  ingestBatchRequest,
  createConnectorRequest,
  createAssetRequest,
  updateAssetRequest,
  loginRequest,
  signedLicense,
  createStoreRequest,
  createPartRequest,
  stockReceiveRequest,
  stockIssueRequest,
  stockReturnRequest,
  stockAdjustRequest,
  stockReserveRequest,
  siteAuthorityRequest,
  cmmsExceptionResolveRequest,
  automationPolicyRequest,
} from '../packages/contracts/src/index.ts';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const outDir = path.join(root, 'docs', 'generated');

const businessEventEnvelope = z.object({
  schema_version: z.literal(1),
  event_id: z.uuid(),
  type: z.enum([
    'maintenance.request.created',
    'maintenance.work_order.created',
    'maintenance.work_order.state_changed',
    'maintenance.plan.occurrence_due',
    'maintenance.inspection.failed',
    'maintenance.downtime.updated',
    'maintenance.recommendation.decided',
  ]),
  aggregate_type: z.string().min(1).max(80),
  aggregate_id: z.uuid(),
  aggregate_version: z.number().int().nonnegative(),
  tenant_id: z.uuid(),
  site_id: z.uuid(),
  occurred_at: z.iso.datetime({ offset: true }),
  correlation_id: z.uuid().nullable(),
  payload: z.record(z.string(), z.unknown()),
});

function schema(name: string, zodSchema: z.ZodType): Record<string, unknown> {
  const json = z.toJSONSchema(zodSchema, { target: 'draft-2020-12' }) as Record<string, unknown>;
  delete json.$schema;
  return { ...json, title: name };
}

const components: Record<string, unknown> = {
  CreateRequest: schema('CreateRequest', createRequestRequest),
  TriageRequest: schema('TriageRequest', triageRequest),
  CreateWorkOrder: schema('CreateWorkOrder', createWorkOrderRequest),
  PatchWorkOrder: schema('PatchWorkOrder', patchWorkOrderRequest),
  TransitionRequest: schema('TransitionRequest', transitionRequest),
  LaborEntry: schema('LaborEntry', laborEntryRequest),
  EvidenceRequest: schema('EvidenceRequest', evidenceRequest),
  CreatePlan: schema('CreatePlan', createPlanRequest),
  PlanRevision: schema('PlanRevision', planRevisionRequest),
  PlanStatus: schema('PlanStatus', planStatusRequest),
  CreateInspectionTemplate: schema('CreateInspectionTemplate', createInspectionTemplateRequest),
  StartInspection: schema('StartInspection', startInspectionRequest),
  SubmitInspection: schema('SubmitInspection', submitInspectionRequest),
  CreateDowntime: schema('CreateDowntime', createDowntimeRequest),
  AmendDowntime: schema('AmendDowntime', amendDowntimeRequest),
  UpsertProfile: schema('UpsertProfile', upsertProfileRequest),
  CreateTeam: schema('CreateTeam', createTeamRequest),
  RoleAssignment: schema('RoleAssignment', roleAssignmentRequest),
  SiteSettings: schema('SiteSettings', siteSettingsRequest),
  NeoAsk: schema('NeoAsk', neoAskRequest),
  RecommendationDecision: schema('RecommendationDecision', recommendationDecisionRequest),
  NormalizedEvent: schema('NormalizedEvent', normalizedEvent),
  IngestBatch: schema('IngestBatch', ingestBatchRequest),
  CreateConnector: schema('CreateConnector', createConnectorRequest),
  CreateAsset: schema('CreateAsset', createAssetRequest),
  UpdateAsset: schema('UpdateAsset', updateAssetRequest),
  Login: schema('Login', loginRequest),
  SignedLicense: schema('SignedLicense', signedLicense),
  CreateStore: schema('CreateStore', createStoreRequest),
  CreatePart: schema('CreatePart', createPartRequest),
  StockReceive: schema('StockReceive', stockReceiveRequest),
  StockIssue: schema('StockIssue', stockIssueRequest),
  StockReturn: schema('StockReturn', stockReturnRequest),
  StockAdjust: schema('StockAdjust', stockAdjustRequest),
  StockReserve: schema('StockReserve', stockReserveRequest),
  SiteAuthority: schema('SiteAuthority', siteAuthorityRequest),
  CmmsExceptionResolve: schema('CmmsExceptionResolve', cmmsExceptionResolveRequest),
  AutomationPolicy: schema('AutomationPolicy', automationPolicyRequest),
  BusinessEvent: schema('BusinessEvent', businessEventEnvelope),
  Error: {
    type: 'object',
    required: ['error'],
    properties: {
      error: {
        type: 'object',
        required: ['code', 'message', 'correlation_id'],
        properties: {
          code: { type: 'string' },
          message: { type: 'string' },
          field_errors: { type: 'object', additionalProperties: { type: 'array', items: { type: 'string' } } },
          correlation_id: { type: 'string', format: 'uuid' },
        },
      },
    },
  },
};

function op(summary: string, opts: { body?: string; response?: string; method?: string } = {}) {
  const method = opts.method ?? 'post';
  const operation: Record<string, unknown> = {
    summary,
    responses: {
      '200': { description: 'OK', ...(opts.response ? { content: { 'application/json': { schema: { $ref: `#/components/schemas/${opts.response}` } } } } : {}) },
      '201': { description: 'Created' },
      '4XX': { description: 'Client error', content: { 'application/json': { schema: { $ref: '#/components/schemas/Error' } } } },
    },
  };
  if (opts.body) {
    operation.requestBody = {
      required: true,
      content: { 'application/json': { schema: { $ref: `#/components/schemas/${opts.body}` } } },
    };
  }
  if (method === 'post') {
    operation.parameters = [{ name: 'Idempotency-Key', in: 'header', required: false, schema: { type: 'string' } }];
  }
  return { [method]: operation };
}

const openapi = {
  openapi: '3.1.0',
  info: {
    title: 'Visibility Maintenance API',
    version: BUILD_VERSION,
    description:
      'Machine-readable contracts generated from Zod schemas in packages/contracts. Identity/registry paths are under /api/v1; maintenance under /api/v1/maintenance.',
  },
  servers: [{ url: '/', description: 'Same-origin private install (nginx) or local Vite proxies' }],
  paths: {
    '/api/v1/identity/sessions': op('Create session', { body: 'Login' }),
    '/api/v1/assets': { get: { summary: 'List assets' }, post: op('Create asset', { body: 'CreateAsset' }).post },
    '/api/v1/assets/{id}': { patch: op('Update asset', { body: 'UpdateAsset', method: 'patch' }).patch },
    '/api/v1/maintenance/requests': { get: { summary: 'List requests' }, post: op('Create request', { body: 'CreateRequest' }).post },
    '/api/v1/maintenance/requests/{id}/triage': op('Triage request', { body: 'TriageRequest' }),
    '/api/v1/maintenance/work-orders': { get: { summary: 'List work orders' }, post: op('Create work order', { body: 'CreateWorkOrder' }).post },
    '/api/v1/maintenance/work-orders/{id}': { get: { summary: 'Get work order' }, patch: op('Patch work order', { body: 'PatchWorkOrder', method: 'patch' }).patch },
    '/api/v1/maintenance/work-orders/{id}/transitions': op('Transition work order', { body: 'TransitionRequest' }),
    '/api/v1/maintenance/work-orders/{id}/labor': op('Add labor', { body: 'LaborEntry' }),
    '/api/v1/maintenance/plans': { get: { summary: 'List plans' }, post: op('Create plan', { body: 'CreatePlan' }).post },
    '/api/v1/maintenance/plans/{id}/revisions': op('Add plan revision', { body: 'PlanRevision' }),
    '/api/v1/maintenance/inspection-templates': op('Create inspection template', { body: 'CreateInspectionTemplate' }),
    '/api/v1/maintenance/inspection-results': op('Start inspection', { body: 'StartInspection' }),
    '/api/v1/maintenance/inspection-results/{id}/submit': op('Submit inspection', { body: 'SubmitInspection' }),
    '/api/v1/maintenance/downtime-events': op('Create downtime', { body: 'CreateDowntime' }),
    '/api/v1/maintenance/asset-profiles/{assetId}': { put: op('Upsert asset profile', { body: 'UpsertProfile', method: 'put' }).put },
    '/api/v1/maintenance/teams': op('Create team', { body: 'CreateTeam' }),
    '/api/v1/maintenance/role-assignments': op('Grant role', { body: 'RoleAssignment' }),
    '/api/v1/maintenance/sites/{siteId}/settings': { put: op('Update site settings', { body: 'SiteSettings', method: 'put' }).put },
    '/api/v1/maintenance/neo/ask': op('Ask Neo (retrieval / review drafts)', { body: 'NeoAsk' }),
    '/api/v1/maintenance/recommendations/{id}/decisions': op('Decide Neo recommendation', { body: 'RecommendationDecision' }),
    '/api/v1/maintenance/connectors': op('Create connector', { body: 'CreateConnector' }),
    '/api/v1/maintenance/integrations/events': op('Ingest normalized events', { body: 'IngestBatch' }),
    '/api/v1/maintenance/licenses': op('Import signed license', { body: 'SignedLicense' }),
    '/api/v1/maintenance/stores': { get: { summary: 'List stores' }, post: op('Create store', { body: 'CreateStore' }).post },
    '/api/v1/maintenance/parts': { get: { summary: 'List parts' }, post: op('Create part', { body: 'CreatePart' }).post },
    '/api/v1/maintenance/stock/receive': op('Receive stock', { body: 'StockReceive' }),
    '/api/v1/maintenance/stock/issue': op('Issue stock to work order', { body: 'StockIssue' }),
    '/api/v1/maintenance/stock/return': op('Return stock from work order', { body: 'StockReturn' }),
    '/api/v1/maintenance/stock/adjust': op('Adjust stock', { body: 'StockAdjust' }),
    '/api/v1/maintenance/stock/reservations': op('Reserve stock', { body: 'StockReserve' }),
    '/api/v1/maintenance/sites/{siteId}/authority': {
      get: { summary: 'Get site work-order authority' },
      put: op('Set site work-order authority', { body: 'SiteAuthority', method: 'put' }).put,
    },
    '/api/v1/maintenance/cmms-exceptions': { get: { summary: 'List CMMS exception queue' } },
    '/api/v1/maintenance/cmms-exceptions/{id}/resolve': op('Resolve CMMS exception', { body: 'CmmsExceptionResolve' }),
    '/api/v1/maintenance/automation-policies': {
      get: { summary: 'List automation policies' },
      put: op('Upsert automation policy', { body: 'AutomationPolicy', method: 'put' }).put,
    },
  },
  components: { schemas: components },
};

const eventSchemas = {
  $schema: 'https://json-schema.org/draft/2020-12/schema',
  title: 'Visibility Maintenance business and integration events',
  description: 'Generated from Zod contracts. Outbox consumers deduplicate on event_id.',
  oneOf: [
    { $ref: '#/$defs/BusinessEvent' },
    { $ref: '#/$defs/NormalizedEvent' },
  ],
  $defs: {
    BusinessEvent: components.BusinessEvent,
    NormalizedEvent: components.NormalizedEvent,
  },
};

await mkdir(outDir, { recursive: true });
await writeFile(path.join(outDir, 'openapi.json'), `${JSON.stringify(openapi, null, 2)}\n`);
await writeFile(path.join(outDir, 'events.schema.json'), `${JSON.stringify(eventSchemas, null, 2)}\n`);
await writeFile(
  path.join(outDir, 'README.md'),
  `# Generated contracts

Produced by \`npx tsx tools/generate-openapi.ts\` from Zod schemas in \`packages/contracts\`.

| File | Purpose |
| --- | --- |
| \`openapi.json\` | OpenAPI 3.1 for representative maintenance/identity routes |
| \`events.schema.json\` | Business outbox events and MC-01 normalized telemetry |

Regenerate before merging contract changes. Do not hand-edit these files.
`,
);
console.log(`Wrote ${path.relative(root, outDir)}/openapi.json and events.schema.json`);
