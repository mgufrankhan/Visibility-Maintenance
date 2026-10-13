export { buildPlatformApp, type PlatformAppOptions } from './app.ts';
export { loadPlatformConfig, type PlatformConfig } from './config.ts';
export { loadOrCreateSigningKey, type SigningKey } from './keys.ts';
export { issueAccessToken } from './identity.ts';
export { loadPrincipal } from './principal.ts';
export * as bootstrap from './bootstrap.ts';
export const PLATFORM_MIGRATIONS_DIR = new URL('../../../database/migrations/platform', import.meta.url).pathname;
