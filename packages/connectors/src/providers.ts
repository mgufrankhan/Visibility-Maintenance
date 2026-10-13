import type { ConnectorProvider } from '@vm/contracts';
import { ProviderNotQualifiedError, type ProviderAdapter } from './adapter.ts';

/**
 * No Live or OpenRemote adapter ships yet: their upstream endpoints,
 * authentication and subscription mechanisms must be selected against the
 * customer's deployed provider version (MC-08). Until a concrete adapter is
 * implemented and qualified, construction always refuses.
 */
export function createProviderAdapter(provider: Exclude<ConnectorProvider, 'simulated'>): ProviderAdapter {
  throw new ProviderNotQualifiedError(provider);
}
