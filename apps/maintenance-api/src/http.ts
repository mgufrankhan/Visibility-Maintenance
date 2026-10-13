import type { FastifyInstance, FastifyRequest } from 'fastify';
import type { Actor, Services } from '@vm/core';
import { AppError } from '@vm/server-kit';

export interface RouteDeps {
  app: FastifyInstance;
  s: Services;
  actor: (req: FastifyRequest) => Promise<Actor>;
}

export const API = '/api/v1/maintenance';

export function idempotencyKey(req: FastifyRequest): string | undefined {
  const h = req.headers['idempotency-key'];
  return typeof h === 'string' && h.length > 0 ? h : undefined;
}

/** Version from If-Match (ETag form) or the body's record_version. */
export function expectedVersion(req: FastifyRequest, bodyVersion?: number): number {
  const h = req.headers['if-match'];
  if (typeof h === 'string') {
    const v = Number(h.replace(/^W\//, '').replace(/"/g, ''));
    if (Number.isInteger(v) && v > 0) {
      if (bodyVersion !== undefined && bodyVersion !== v) throw new AppError(422, 'validation_failed', 'If-Match and record_version disagree');
      return v;
    }
  }
  if (bodyVersion !== undefined) return bodyVersion;
  throw new AppError(428, 'precondition_required', 'If-Match or record_version is required');
}

export function param(req: FastifyRequest, name: string): string {
  return (req.params as Record<string, string>)[name] ?? '';
}
