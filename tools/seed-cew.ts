/**
 * Creates the CEW foundry organization with melt/mold mock data and runs the
 * corrective maintenance flow against a running local stack (`npm run dev`).
 *
 *   npm run seed:cew
 */
import { randomUUID } from 'node:crypto';
import { access, mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createServices, syncRegistry, readJsonFile } from '@vm/core';
import { createPool } from '@vm/db';
import { generateSigningKeyPair, signLicense } from '@vm/licensing';
import { setupTenant, SetupError } from '@vm/ops';
import { HttpRegistryClient } from '@vm/registry';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const DEV_DIR = path.join(ROOT, '.dev');
const DB_NAME = process.env.VM_DEV_DATABASE ?? 'vm_dev';
const ADMIN_URL = process.env.TEST_DATABASE_ADMIN_URL ?? 'postgres://localhost:5432/postgres';
const PLATFORM_URL = process.env.PLATFORM_URL ?? 'http://127.0.0.1:5191';
const API_URL = process.env.API_URL ?? 'http://127.0.0.1:5192';
const M = '/api/v1/maintenance';

const TENANT = 'cew';
const PASSWORD = 'cew-password-1';
const ADMIN_EMAIL = 'admin@cew.local';
const ADMIN_PASSWORD = 'cew-admin-password';
const ISSUER_KID = 'dev-issuer';

type Json = Record<string, unknown>;

function log(msg: string): void {
  console.log(`[seed-cew] ${msg}`);
}

function fail(msg: string): never {
  console.error(`[seed-cew] ${msg}`);
  process.exit(1);
}

async function exists(file: string): Promise<boolean> {
  try {
    await access(file);
    return true;
  } catch {
    return false;
  }
}

async function ensureIssuerKeys(): Promise<{ publicKeysFile: string; privateKeyPem: string }> {
  const issuerDir = path.join(DEV_DIR, 'issuer');
  const pubFile = path.join(issuerDir, 'public-keys.json');
  const privFile = path.join(issuerDir, `${ISSUER_KID}.private.pem`);
  if (!(await exists(pubFile)) || !(await exists(privFile))) {
    await mkdir(issuerDir, { recursive: true, mode: 0o700 });
    const { publicKeyPem, privateKeyPem } = generateSigningKeyPair();
    await writeFile(privFile, privateKeyPem, { mode: 0o600 });
    await writeFile(pubFile, JSON.stringify({ [ISSUER_KID]: publicKeyPem }, null, 2));
    fail(`Created issuer keys at ${issuerDir}. Restart \`npm run dev\` so the API loads LICENSE_PUBLIC_KEYS_FILE, then re-run \`npm run seed:cew\`.`);
  }
  return { publicKeysFile: pubFile, privateKeyPem: await readFile(privFile, 'utf8') };
}

async function api<T = any>(
  base: string,
  token: string | null,
  method: string,
  pathName: string,
  body?: unknown,
  headers: Record<string, string> = {},
): Promise<{ status: number; body: T }> {
  const res = await fetch(`${base}${pathName}`, {
    method,
    headers: {
      ...(body !== undefined ? { 'content-type': 'application/json' } : {}),
      ...(token ? { authorization: `Bearer ${token}` } : {}),
      ...headers,
    },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const text = await res.text();
  let parsed: any = text;
  try {
    parsed = text ? JSON.parse(text) : null;
  } catch {
    /* raw */
  }
  return { status: res.status, body: parsed as T };
}

async function must<T>(label: string, p: Promise<{ status: number; body: T }>, ok: number | number[] = 200): Promise<T> {
  const allowed = Array.isArray(ok) ? ok : [ok];
  const r = await p;
  if (!allowed.includes(r.status)) fail(`${label} failed (${r.status}): ${JSON.stringify(r.body)}`);
  return r.body;
}

async function login(email: string, password: string): Promise<string> {
  const r = await api<{ access_token: string }>(PLATFORM_URL, null, 'POST', '/api/v1/identity/sessions', {
    tenant: TENANT,
    email,
    password,
  });
  if (r.status !== 200) fail(`login ${email} failed: ${JSON.stringify(r.body)}`);
  return r.body.access_token;
}

async function main(): Promise<void> {
  const ready = await fetch(`${API_URL}/health/ready`).catch(() => null);
  if (!ready?.ok) fail(`maintenance API not ready at ${API_URL}; start with \`npm run dev\` first`);

  const { publicKeysFile, privateKeyPem } = await ensureIssuerKeys();
  const credentialsFile = path.join(DEV_DIR, 'config', 'system-credentials.json');
  const secretFile = path.join(DEV_DIR, 'download-link-secret');
  if (!(await exists(secretFile))) fail(`missing ${secretFile}; start \`npm run dev\` once first`);
  const downloadLinkSecret = (await readFile(secretFile, 'utf8')).trim();

  const base = new URL(ADMIN_URL);
  base.pathname = `/${DB_NAME}`;
  const databaseUrl = base.toString();
  const pool = createPool(databaseUrl, { max: 4, applicationName: 'vm-seed-cew' });

  let setup: { tenant_id: string; site_id: string; installation_id: string };
  const existing = await pool.query<{ id: string }>(`SELECT id FROM platform.tenant WHERE slug = $1`, [TENANT]);
  if (existing.rowCount) {
    log(`tenant ${TENANT} already exists — refreshing foundry mock data and completing flow`);
    const tenantId = existing.rows[0]!.id;
    await pool.query(`UPDATE platform.tenant SET name = 'CEW Foundry' WHERE id = $1`, [tenantId]);
    const site = await pool.query<{ id: string }>(`SELECT id FROM platform.site WHERE tenant_id = $1 ORDER BY code LIMIT 1`, [tenantId]);
    if (!site.rowCount) fail('CEW tenant has no site');
    await pool.query(`UPDATE platform.site SET code = 'FND1', name = 'Foundry Bay 1', timezone = 'Asia/Karachi' WHERE id = $1`, [
      site.rows[0]!.id,
    ]);
    const install = await pool.query<{ value: string }>(
      `SELECT value #>> '{}' AS value FROM maintenance.installation_state WHERE key = 'installation_id'`,
    );
    setup = { tenant_id: tenantId, site_id: site.rows[0]!.id, installation_id: install.rows[0]!.value };
  } else {
    log('creating organization CEW Foundry');
    try {
      const result = await setupTenant(
        { platform: pool, maintenance: pool },
        new HttpRegistryClient({ baseUrl: PLATFORM_URL }),
        {
          tenant: { slug: TENANT, name: 'CEW Foundry' },
          site: { code: 'FND1', name: 'Foundry Bay 1', timezone: 'Asia/Karachi' },
          admin: { email: ADMIN_EMAIL, displayName: 'CEW Foundry Admin', password: ADMIN_PASSWORD },
          systemCredentialsFile: credentialsFile,
        },
      );
      setup = {
        tenant_id: result.tenant_id,
        site_id: result.site_id,
        installation_id: result.installation_id,
      };
      log(`tenant ${setup.tenant_id} site ${setup.site_id}`);
    } catch (err) {
      if (err instanceof SetupError) fail(err.message);
      throw err;
    }
  }

  const publicKeys = JSON.parse(await readFile(publicKeysFile, 'utf8')) as Record<string, string>;
  const services = createServices({
    db: pool,
    platformUrl: PLATFORM_URL,
    blobRoot: path.join(DEV_DIR, 'blobs'),
    licensePublicKeys: publicKeys,
    systemCredentials: readJsonFile(credentialsFile, {}),
    config: { downloadLinkSecret, allowSimulatedConnectors: true, neoInferencePolicy: 'private_only' },
    entitlementCacheTtlMs: 0,
  });
  log('syncing registry snapshots for CEW');
  const synced = await syncRegistry(services, setup.tenant_id);
  log(`synced sites=${synced.sites} change_items=${synced.assets}`);

  const adminToken = await login(ADMIN_EMAIL, ADMIN_PASSWORD);

  const entitlements = await api<Json>(API_URL, adminToken, 'GET', `${M}/entitlements`);
  if (entitlements.status !== 200) fail(`entitlements: ${JSON.stringify(entitlements.body)}`);
  if (!(entitlements.body.capabilities as string[] | undefined)?.includes('core.create_work')) {
    log('importing Core license for CEW');
    const signed = signLicense(
      {
        license_id: `LIC-CEW-${randomUUID().slice(0, 8)}`,
        product: 'visibility-maintenance',
        tenant_id: setup.tenant_id,
        installation_id: setup.installation_id,
        features: ['core', 'connected_operations', 'neo_assistance'],
        limits: { sites: 5, operational_users: 50, maintainable_assets: 500 },
        term: { starts_at: '2026-01-01T00:00:00Z', ends_at: '2099-01-01T00:00:00Z' },
        grace_days: 30,
        policy_tag: 'dev-cew-demo',
        issued_at: new Date().toISOString(),
        key_id: ISSUER_KID,
      },
      privateKeyPem,
    );
    await must('license import', api(API_URL, adminToken, 'POST', `${M}/licenses`, signed), 201);
  } else {
    log('license already grants core.create_work');
  }

  const mkUser = async (email: string, displayName: string, role: string): Promise<{ id: string; token: string }> => {
    const listed = await must<{ items: Array<{ id: string; email?: string | null }> }>(
      'list users',
      api(PLATFORM_URL, adminToken, 'GET', '/api/v1/identity/users'),
    );
    const want = email.toLowerCase();
    let user = listed.items.find((u) => typeof u.email === 'string' && u.email.toLowerCase() === want);
    if (!user) {
      user = await must(
        `create ${email}`,
        api(PLATFORM_URL, adminToken, 'POST', '/api/v1/identity/users', {
          email,
          display_name: displayName,
          password: PASSWORD,
          site_ids: [setup.site_id],
        }),
        201,
      );
      await must(
        `role ${role}`,
        api(API_URL, adminToken, 'POST', `${M}/role-assignments`, { user_id: user!.id, role, site_id: setup.site_id }),
        201,
      );
    }
    return { id: user!.id, token: await login(email, PASSWORD) };
  };

  const assetAdmin = await (async () => {
    const email = 'assets@cew.local';
    const listed = await must<{ items: Array<{ id: string; email: string | null }> }>(
      'list users',
      api(PLATFORM_URL, adminToken, 'GET', '/api/v1/identity/users'),
    );
    let user = listed.items.find((u) => u.email === email);
    if (!user) {
      user = await must(
        'create asset admin',
        api(PLATFORM_URL, adminToken, 'POST', '/api/v1/identity/users', {
          email,
          display_name: 'CEW Asset Admin',
          password: PASSWORD,
          site_ids: [setup.site_id],
        }),
        201,
      );
      await must(
        'platform asset_admin',
        api(PLATFORM_URL, adminToken, 'POST', `/api/v1/identity/users/${user!.id}/platform-roles`, { role: 'asset_admin', site_id: null }),
        201,
      );
      await must(
        'maint asset_administrator',
        api(API_URL, adminToken, 'POST', `${M}/role-assignments`, { user_id: user!.id, role: 'asset_administrator', site_id: null }),
        201,
      );
    }
    return { id: user!.id, token: await login(email, PASSWORD) };
  })();

  const sup = await mkUser('supervisor@cew.local', 'Melt Deck Supervisor', 'supervisor');
  const sup2 = await mkUser('supervisor2@cew.local', 'Molding Supervisor', 'supervisor');
  const tech = await mkUser('tech@cew.local', 'Furnace Technician', 'technician');
  const reporter = await mkUser('reporter@cew.local', 'Melt Deck Operator', 'reporter');

  /** Archive prior non-foundry demo assets so the registry reads as a foundry. */
  const legacyCodes = ['KILN-01', 'CONV-12', 'PUMP-07', 'CMP-03', 'XFMR-01'];
  for (const code of legacyCodes) {
    const row = await pool.query<{ id: string; version: number; lifecycle: string }>(
      `SELECT id, version, lifecycle FROM platform.asset WHERE tenant_id = $1 AND site_id = $2 AND code = $3`,
      [setup.tenant_id, setup.site_id, code],
    );
    if (!row.rowCount || row.rows[0]!.lifecycle !== 'active') continue;
    await must(
      `archive ${code}`,
      api(
        PLATFORM_URL,
        assetAdmin.token,
        'POST',
        `/api/v1/assets/${row.rows[0]!.id}/archive`,
        { reason: 'Replaced by CEW foundry asset mock data' },
        { 'if-match': `"${row.rows[0]!.version}"` },
      ),
    );
  }

  const assetDefs = [
    { code: 'FURN-01', name: 'Induction melting furnace A', location: 'Melt deck north', asset_type: 'furnace' },
    { code: 'FURN-02', name: 'Induction melting furnace B', location: 'Melt deck south', asset_type: 'furnace' },
    { code: 'LADLE-02', name: 'Transfer ladle 2', location: 'Pour aisle', asset_type: 'ladle' },
    { code: 'MOLD-01', name: 'Green sand molding line', location: 'Molding bay', asset_type: 'molding_line' },
    { code: 'MIX-01', name: 'Sand mixer', location: 'Sand plant', asset_type: 'mixer' },
    { code: 'SHAKE-01', name: 'Shakeout deck', location: 'Knockout', asset_type: 'shakeout' },
    { code: 'BLAST-01', name: 'Shot blast cabinet', location: 'Cleaning bay', asset_type: 'blast' },
    { code: 'CRANE-03', name: 'Bay 3 overhead crane', location: 'Melt deck', asset_type: 'crane' },
    { code: 'BAGH-01', name: 'Baghouse dust collector', location: 'Melt deck roof', asset_type: 'dust_collector' },
  ];

  const assets: Record<string, { id: string; name: string }> = {};
  for (const a of assetDefs) {
    const existingAsset = await pool.query<{ id: string; lifecycle: string; version: number }>(
      `SELECT id, lifecycle, version FROM platform.asset WHERE tenant_id = $1 AND site_id = $2 AND code = $3`,
      [setup.tenant_id, setup.site_id, a.code],
    );
    if (existingAsset.rowCount) {
      const row = existingAsset.rows[0]!;
      if (row.lifecycle === 'archived') {
        await must(
          `reactivate ${a.code}`,
          api(
            PLATFORM_URL,
            assetAdmin.token,
            'POST',
            `/api/v1/assets/${row.id}/reactivate`,
            { reason: 'CEW foundry mock data' },
            { 'if-match': `"${row.version}"` },
          ),
        );
      }
      const current = await must<{ id: string; version: number }>(
        `get ${a.code}`,
        api(PLATFORM_URL, assetAdmin.token, 'GET', `/api/v1/assets/${row.id}`),
      );
      await must(
        `update ${a.code}`,
        api(
          PLATFORM_URL,
          assetAdmin.token,
          'PATCH',
          `/api/v1/assets/${row.id}`,
          { name: a.name, location: a.location, asset_type: a.asset_type },
          { 'if-match': `"${current.version}"` },
        ),
      );
      assets[a.code] = { id: row.id, name: a.name };
      continue;
    }
    const created = await must<{ id: string }>(
      `asset ${a.code}`,
      api(PLATFORM_URL, assetAdmin.token, 'POST', '/api/v1/assets', {
        site_id: setup.site_id,
        code: a.code,
        name: a.name,
        location: a.location,
        asset_type: a.asset_type,
      }),
      201,
    );
    assets[a.code] = { id: created.id, name: a.name };
  }
  log(`foundry assets: ${Object.keys(assets).join(', ')}`);
  await syncRegistry(services, setup.tenant_id);

  const ensureTeam = async (name: string, memberIds: string[]): Promise<string> => {
    const teams = await must<{ items: Array<{ id: string; name: string }> }>(
      'list teams',
      api(API_URL, adminToken, 'GET', `${M}/teams?site_id=${setup.site_id}`),
    );
    const found = teams.items.find((t) => t.name === name);
    if (found) return found.id;
    const team = await must<{ id: string }>(
      `create team ${name}`,
      api(API_URL, adminToken, 'POST', `${M}/teams`, {
        site_id: setup.site_id,
        name,
        member_ids: memberIds,
      }),
      201,
    );
    return team.id;
  };
  const meltTeamId = await ensureTeam('Melt Deck', [tech.id]);
  await ensureTeam('Molding Line', [tech.id]);

  let revisionId: string;
  const PROC_TITLE = 'Furnace cooling jacket service';
  const procedures = await must<{
    items: Array<{ id: string; title: string; revisions: Array<{ id: string; status: string }> }>;
  }>('list procedures', api(API_URL, sup.token, 'GET', `${M}/procedures?site_id=${setup.site_id}`));
  const existingProc = procedures.items.find((p) => p.title === PROC_TITLE);
  if (existingProc) {
    const published = existingProc.revisions.find((r) => r.status === 'published');
    revisionId = published?.id ?? fail('procedure has no published revision');
  } else {
    const proc = await must<{ id: string }>(
      'create procedure',
      api(API_URL, sup.token, 'POST', `${M}/procedures`, { site_id: setup.site_id, title: PROC_TITLE }),
      201,
    );
    const rev = await must<{ id: string }>(
      'create revision',
      api(API_URL, sup.token, 'POST', `${M}/procedures/${proc.id}/revisions`, {
        safety_instructions:
          'Confirm furnace is drained and isolated. Wear aluminized PPE. Verify cooling water locked out before opening jacket flanges.',
        steps: [
          { key: 'lockout', label: 'Electrical and water lockout applied', type: 'acknowledgment', safety_critical: true },
          { key: 'leak_test', label: 'Jacket pressure hold test', type: 'numeric', unit: 'bar', min: 2.5, max: 4.0 },
          { key: 'refract', label: 'Refractory lining inspected OK', type: 'pass_fail' },
          { key: 'cooldown', label: 'Cooling flow restored and verified', type: 'pass_fail' },
        ],
      }),
      201,
    );
    await must('publish procedure', api(API_URL, sup.token, 'POST', `${M}/procedure-revisions/${rev.id}/publish`));
    revisionId = rev.id;
  }

  const plans = await must<{ items: Array<{ id: string; title: string }> }>(
    'list plans',
    api(API_URL, sup.token, 'GET', `${M}/plans?site_id=${setup.site_id}`),
  );
  if (!plans.items.find((p) => p.title === 'Furnace weekly cooling check')) {
    const plan = await must<{ id: string }>(
      'create PM plan',
      api(API_URL, sup.token, 'POST', `${M}/plans`, {
        site_id: setup.site_id,
        asset_id: assets['FURN-01']!.id,
        title: 'Furnace weekly cooling check',
      }),
      201,
    );
    const planRev = await must<{ id: string }>(
      'create plan revision',
      api(API_URL, sup.token, 'POST', `${M}/plans/${plan.id}/revisions`, {
        title: 'Inspect induction furnace cooling circuit',
        scope: 'Check jacket for scale, leaks, and flow; verify interlocks',
        procedure_revision_id: revisionId,
        team_id: meltTeamId,
        estimated_minutes: 45,
        lead_days: 2,
        trigger: { type: 'calendar', unit: 'week', interval: 1, anchor_date: '2026-10-14', time_of_day: '06:00' },
        effective_from: '2026-10-12',
      }),
      201,
    );
    await must('publish plan', api(API_URL, sup.token, 'POST', `${M}/plan-revisions/${planRev.id}/publish`));
    log('published weekly PM on FURN-01');
  }

  const templates = await must<{ items: Array<{ id: string; title: string }> }>(
    'list inspection templates',
    api(API_URL, sup.token, 'GET', `${M}/inspection-templates?site_id=${setup.site_id}`),
  );
  if (!templates.items.find((t) => t.title === 'Melt deck shift round')) {
    const tpl = await must<{ id: string }>(
      'create inspection template',
      api(API_URL, sup.token, 'POST', `${M}/inspection-templates`, { site_id: setup.site_id, title: 'Melt deck shift round' }),
      201,
    );
    await must(
      'inspection revision',
      api(API_URL, sup.token, 'POST', `${M}/inspection-templates/${tpl.id}/revisions`, {
        checks: [
          { key: 'cooling_flow', label: 'Furnace cooling flow normal', type: 'pass_fail' },
          { key: 'ladle_dry', label: 'Ladle preheated / dry', type: 'pass_fail' },
          { key: 'crane_path', label: 'Crane travel path clear', type: 'pass_fail' },
          { key: 'baghouse_dp', label: 'Baghouse differential pressure OK', type: 'pass_fail' },
        ],
      }),
      201,
    );
    await must('publish inspection', api(API_URL, sup.token, 'POST', `${M}/inspection-templates/${tpl.id}/publish`));
    log('published melt deck shift inspection');
  }

  log('running foundry corrective flow: request → triage → approve → execute → close');
  const request = await must<{ id: string; version: number }>(
    'fault request',
    api(API_URL, reporter.token, 'POST', `${M}/requests`, {
      site_id: setup.site_id,
      asset_id: assets['FURN-01']!.id,
      description: 'Induction furnace A cooling jacket weeping at lower flange during heat 14 — steam visible, melt paused',
      observed_at: new Date().toISOString(),
      proposed_priority: 'high',
    }),
    201,
  );

  const triage = await must<{ created_work_order_id: string }>(
    'triage accept',
    api(API_URL, sup.token, 'POST', `${M}/requests/${request.id}/triage`, {
      action: 'accept',
      record_version: request.version,
      draft: {
        title: 'Repair FURN-01 cooling jacket flange',
        priority: 'high',
        team_id: meltTeamId,
        scope: 'Replace jacket gasket, pressure-test circuit, restore melt interlocks',
      },
    }),
  );
  const woId = triage.created_work_order_id;

  let wo = await must<{ id: string; version: number; state: string }>(
    'get WO',
    api(API_URL, sup.token, 'GET', `${M}/work-orders/${woId}`),
  );
  wo = await must(
    'plan WO',
    api(
      API_URL,
      sup.token,
      'PATCH',
      `${M}/work-orders/${woId}`,
      {
        planned_start: '2026-10-13T04:00:00Z',
        planned_end: '2026-10-13T10:00:00Z',
        procedure_revision_id: revisionId,
        assignee_id: tech.id,
      },
      { 'if-match': `"${wo.version}"` },
    ),
  );

  const transition = async (token: string, action: string, extra: Record<string, unknown> = {}) => {
    const current = await must<{ version: number; state: string }>(
      'get WO',
      api(API_URL, token, 'GET', `${M}/work-orders/${woId}`),
    );
    return must(
      action,
      api(API_URL, token, 'POST', `${M}/work-orders/${woId}/transitions`, {
        action,
        record_version: current.version,
        ...extra,
      }),
    );
  };

  await transition(sup.token, 'submit_for_approval');
  await transition(sup2.token, 'approve');
  await transition(tech.token, 'start');
  await must(
    'results',
    api(API_URL, tech.token, 'POST', `${M}/work-orders/${woId}/results`, {
      results: [
        { key: 'lockout', value: true },
        { key: 'leak_test', value: 3.2, unit: 'bar' },
        { key: 'refract', value: true },
        { key: 'cooldown', value: true },
      ],
    }),
    201,
  );
  await transition(tech.token, 'submit_completion', {
    completion: {
      corrective_action: 'Replaced lower flange gasket, hydro-tested jacket to 3.2 bar, restored cooling flow interlock',
      cause_code: 'SEAL',
    },
  });
  await transition(sup.token, 'close', { closure_outcome: 'restored' });

  const finalWo = await must<{ state: string; title: string; transitions: Array<{ action: string }> }>(
    'final WO',
    api(API_URL, adminToken, 'GET', `${M}/work-orders/${woId}`),
  );

  await pool.end();

  console.log('');
  log('CEW Foundry ready');
  console.log(
    JSON.stringify(
      {
        tenant: TENANT,
        name: 'CEW Foundry',
        site: 'Foundry Bay 1 (FND1)',
        tenant_id: setup.tenant_id,
        site_id: setup.site_id,
        web: 'http://127.0.0.1:5173',
        login: {
          admin: { email: ADMIN_EMAIL, password: ADMIN_PASSWORD },
          melt_supervisor: { email: 'supervisor@cew.local', password: PASSWORD },
          molding_supervisor: { email: 'supervisor2@cew.local', password: PASSWORD },
          furnace_tech: { email: 'tech@cew.local', password: PASSWORD },
          melt_operator: { email: 'reporter@cew.local', password: PASSWORD },
        },
        assets: Object.entries(assets).map(([code, a]) => `${code}: ${a.name}`),
        teams: ['Melt Deck', 'Molding Line'],
        closed_work_order: {
          id: woId,
          state: finalWo.state,
          title: finalWo.title,
          transitions: finalWo.transitions.map((t) => t.action),
        },
      },
      null,
      2,
    ),
  );
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
