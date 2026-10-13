import { createHash } from 'node:crypto';
import { canonicalJson } from '@vm/contracts';
import type { ProviderEvent } from './adapter.ts';

/**
 * MC-04 deterministic source key for providers without stable event IDs:
 * sha256 over provider instance, external asset, attribute, original source
 * timestamp and value. Two provider occurrences that agree on all of these are
 * indistinguishable and are treated as one; no sequence number is invented.
 * Events without a source timestamp cannot be keyed deterministically and
 * must be rejected by the caller.
 */
export function deterministicSourceKey(providerInstance: string, e: Pick<ProviderEvent, 'external_asset_id' | 'external_attribute' | 'observed_at' | 'value'>): string {
  if (!e.observed_at) throw new Error('A deterministic source key requires the original source timestamp');
  const digest = createHash('sha256')
    .update(canonicalJson([providerInstance, e.external_asset_id, e.external_attribute, e.observed_at, e.value]))
    .digest('hex');
  return `det:${digest}`;
}
