import { z } from 'zod';

export const PLATFORM_ROLES = ['platform_admin', 'asset_admin', 'mapping_admin'] as const;
export type PlatformRole = (typeof PLATFORM_ROLES)[number];

export const loginRequest = z.object({
  tenant: z.string().min(1).max(63),
  email: z.email().max(320),
  password: z.string().min(1).max(512),
});

export const tokenRequest = z.discriminatedUnion('grant_type', [
  z.object({ grant_type: z.literal('refresh_token'), refresh_token: z.string().min(16).max(512) }),
  z.object({
    grant_type: z.literal('client_credentials'),
    client_id: z.string().min(1).max(200),
    client_secret: z.string().min(16).max(512),
  }),
]);

export interface TokenResponse {
  access_token: string;
  token_type: 'Bearer';
  expires_in: number;
  refresh_token?: string;
}

/** Claims issued by the included identity service and expected from any replacement IdP. */
export interface AccessTokenClaims {
  sub: string;
  tid: string;
  kind: 'human' | 'service';
  name: string;
  email?: string;
  sites: string[];
  proles: Array<{ r: PlatformRole; s: string | null }>;
}

export const createUserRequest = z.object({
  email: z.email().max(320),
  display_name: z.string().min(1).max(200),
  password: z.string().min(12).max(512),
  site_ids: z.array(z.uuid()).default([]),
});

export const createServiceAccountRequest = z.object({
  name: z.string().min(1).max(200),
  site_ids: z.array(z.uuid()).default([]),
});

export const createSiteRequest = z.object({
  code: z.string().min(1).max(40).regex(/^[A-Za-z0-9_-]+$/),
  name: z.string().min(1).max(200),
  timezone: z.string().min(1).max(64),
});

export const membershipRequest = z.object({ site_id: z.uuid() });

export const platformRoleRequest = z.object({
  role: z.enum(PLATFORM_ROLES),
  site_id: z.uuid().nullable().default(null),
});

export interface SiteDto {
  id: string;
  tenant_id: string;
  code: string;
  name: string;
  timezone: string;
  status: 'active' | 'archived';
  version: number;
}

export interface UserDto {
  id: string;
  tenant_id: string;
  kind: 'human' | 'service';
  email: string | null;
  display_name: string;
  status: 'active' | 'disabled';
  site_ids: string[];
  platform_roles: Array<{ role: PlatformRole; site_id: string | null }>;
}
