import { readFileSync } from 'node:fs';

/**
 * Reads a setting from `NAME`, or from the file named by `NAME_FILE` so
 * secrets can be mounted (for example as Compose secrets) instead of being
 * placed in the environment.
 */
export function readSecret(name: string): string | undefined {
  const file = process.env[`${name}_FILE`];
  if (file) return readFileSync(file, 'utf8').trim();
  const v = process.env[name];
  return v === undefined || v === '' ? undefined : v;
}

export function requiredSecret(name: string): string {
  const v = readSecret(name);
  if (!v) throw new Error(`Missing required setting ${name} (or ${name}_FILE)`);
  return v;
}
