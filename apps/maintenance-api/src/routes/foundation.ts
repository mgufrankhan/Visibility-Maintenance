import {
  createTeamRequest,
  pageQuery,
  roleAssignmentRequest,
  siteSettingsRequest,
  upsertProfileRequest,
} from '@vm/contracts';
import {
  createTeam,
  getAssetProfile,
  getSiteSettings,
  grantRole,
  listAssetProfiles,
  listRoleAssignments,
  listTeams,
  requireTenantPermission,
  revokeRole,
  setTeamMembers,
  updateSiteSettings,
  upsertProfile,
  resolveQrToken,
} from '@vm/core';
import { effectivePermissions, sitesWith } from '@vm/policy';
import { parse } from '@vm/server-kit';
import { z } from 'zod';
import { API, param, type RouteDeps } from '../http.ts';

export function registerFoundationRoutes({ app, s, actor }: RouteDeps): void {
  app.get(`${API}/me`, async (req) => {
    const a = await actor(req);
    const p = a.principal;
    return {
      user_id: p.userId,
      tenant_id: p.tenantId,
      kind: p.kind,
      display_name: p.displayName,
      roles: p.roles.map((r) => ({ role: r.role, site_id: r.siteId })),
      sites: p.memberSiteIds.map((siteId) => ({ site_id: siteId, permissions: effectivePermissions(p, siteId) })),
      maintenance_sites: sitesWith(p, 'maintenance.view'),
    };
  });

  app.get(`${API}/entitlements`, async (req) => {
    const a = await actor(req);
    const view = await s.entitlements.view(a.principal.tenantId);
    // Signature material and raw documents are never returned.
    return { ...view, installation_id: await s.entitlements.installationId() };
  });

  app.post(`${API}/licenses`, async (req, reply) => {
    const a = await actor(req);
    requireTenantPermission(a.principal, 'maintenance.license.manage');
    const view = await s.entitlements.importLicense(a, req.body);
    return reply.status(201).send(view);
  });

  app.get(`${API}/role-assignments`, async (req) => ({ items: await listRoleAssignments(s, await actor(req)), next_cursor: null }));

  app.post(`${API}/role-assignments`, async (req, reply) => {
    const a = await actor(req);
    return reply.status(201).send(await grantRole(s, a, parse(roleAssignmentRequest, req.body)));
  });

  app.delete(`${API}/role-assignments/:id`, async (req, reply) => {
    await revokeRole(s, await actor(req), param(req, 'id'));
    return reply.status(204).send();
  });

  app.get(`${API}/teams`, async (req) => {
    const q = parse(z.object({ site_id: z.uuid().optional() }), req.query);
    return { items: await listTeams(s, await actor(req), q.site_id), next_cursor: null };
  });

  app.post(`${API}/teams`, async (req, reply) => {
    return reply.status(201).send(await createTeam(s, await actor(req), parse(createTeamRequest, req.body)));
  });

  app.put(`${API}/teams/:id/members`, async (req) => {
    const body = parse(z.object({ member_ids: z.array(z.uuid()).max(500) }), req.body);
    return setTeamMembers(s, await actor(req), param(req, 'id'), body.member_ids);
  });

  app.get(`${API}/sites/:siteId/settings`, async (req) => getSiteSettings(s, await actor(req), param(req, 'siteId')));

  app.put(`${API}/sites/:siteId/settings`, async (req) =>
    updateSiteSettings(s, await actor(req), param(req, 'siteId'), parse(siteSettingsRequest, req.body)),
  );

  app.get(`${API}/asset-profiles`, async (req) => {
    const q = parse(
      pageQuery.extend({ site_id: z.uuid().optional(), q: z.string().max(100).optional(), lifecycle: z.enum(['active', 'archived', 'tombstoned']).optional() }),
      req.query,
    );
    return listAssetProfiles(s, await actor(req), q);
  });

  app.get(`${API}/asset-profiles/:assetId`, async (req) => getAssetProfile(s, await actor(req), param(req, 'assetId')));

  app.put(`${API}/asset-profiles/:assetId`, async (req) =>
    upsertProfile(s, await actor(req), param(req, 'assetId'), parse(upsertProfileRequest, req.body)),
  );

  app.get(`${API}/qr/:token`, async (req) => resolveQrToken(s, await actor(req), param(req, 'token')));
}
