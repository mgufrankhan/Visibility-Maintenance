import { requiredSecret } from '@vm/server-kit';

export interface PlatformConfig {
  databaseUrl: string;
  /** Issuer URL placed in tokens; must match what verifiers are configured with. */
  issuer: string;
  keyFile: string;
  port: number;
  host: string;
  accessTokenTtlSeconds: number;
  refreshTokenTtlSeconds: number;
  audiences: string[];
}

function required(name: string): string {
  const v = process.env[name];
  if (!v) throw new Error(`Missing required environment variable ${name}`);
  return v;
}

export function loadPlatformConfig(): PlatformConfig {
  return {
    databaseUrl: requiredSecret('PLATFORM_DATABASE_URL'),
    issuer: required('PLATFORM_ISSUER'),
    keyFile: required('PLATFORM_SIGNING_KEY_FILE'),
    port: Number(process.env.PORT ?? 4100),
    host: process.env.HOST ?? '0.0.0.0',
    accessTokenTtlSeconds: Number(process.env.ACCESS_TOKEN_TTL_SECONDS ?? 900),
    refreshTokenTtlSeconds: Number(process.env.REFRESH_TOKEN_TTL_SECONDS ?? 7 * 24 * 3600),
    audiences: (process.env.TOKEN_AUDIENCES ?? 'visibility-platform,visibility-maintenance').split(','),
  };
}
