import { z } from 'zod';

/** Release version of this source tree; kept equal to the root package.json version. */
export const BUILD_VERSION = '0.1.0';

export const uuid = z.uuid();
export const isoTimestamp = z.iso.datetime({ offset: true });

export const pageQuery = z.object({
  cursor: z.string().max(200).optional(),
  limit: z.coerce.number().int().min(1).max(200).default(50),
});

export interface Page<T> {
  items: T[];
  next_cursor: string | null;
}

export interface ApiError {
  error: {
    code: string;
    message: string;
    field_errors?: Record<string, string[]>;
    correlation_id: string;
  };
}

export const priority = z.enum(['critical', 'high', 'normal', 'low']);
export type Priority = z.infer<typeof priority>;

export const criticality = z.enum(['a_critical', 'b_important', 'c_standard']);
export type Criticality = z.infer<typeof criticality>;

/** Deterministic JSON with sorted object keys, used for signatures and payload hashes. */
export function canonicalJson(value: unknown): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value) ?? 'null';
  if (value instanceof Date) return JSON.stringify(value.toISOString());
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`;
  const entries = Object.entries(value as Record<string, unknown>)
    .filter(([, v]) => v !== undefined)
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
  return `{${entries.map(([k, v]) => `${JSON.stringify(k)}:${canonicalJson(v)}`).join(',')}}`;
}

/** Cursor encodes the sort key and an ID tiebreaker. */
export function encodeCursor(sortKey: string, id: string): string {
  return Buffer.from(JSON.stringify([sortKey, id])).toString('base64url');
}

export function decodeCursor(cursor: string | undefined): [string, string] | null {
  if (!cursor) return null;
  try {
    const parsed = JSON.parse(Buffer.from(cursor, 'base64url').toString('utf8'));
    if (Array.isArray(parsed) && parsed.length === 2 && typeof parsed[0] === 'string' && typeof parsed[1] === 'string') {
      return [parsed[0], parsed[1]];
    }
  } catch {
    // fall through
  }
  return null;
}
