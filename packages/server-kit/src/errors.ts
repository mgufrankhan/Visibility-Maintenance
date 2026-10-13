import { randomUUID } from 'node:crypto';
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { z, type ZodType } from 'zod';

export class AppError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
    readonly fieldErrors?: Record<string, string[]>,
  ) {
    super(message);
  }
}

export const unauthorized = (msg = 'Authentication required') => new AppError(401, 'unauthenticated', msg);
export const forbidden = (msg = 'You do not have permission for this action') => new AppError(403, 'forbidden', msg);
/** Used for both absent and concealed records so existence is never disclosed. */
export const notFound = (what = 'Record') => new AppError(404, 'not_found', `${what} not found`);
export const conflict = (code: string, msg: string) => new AppError(409, code, msg);
export const staleVersion = (current: number) =>
  new AppError(409, 'version_conflict', `Record has changed (current version ${current}); reload and retry`);
export const invalid = (msg: string, fieldErrors?: Record<string, string[]>) =>
  new AppError(422, 'validation_failed', msg, fieldErrors);

export function parse<S extends ZodType>(schema: S, data: unknown): z.output<S> {
  const r = schema.safeParse(data);
  if (r.success) return r.data;
  const fieldErrors: Record<string, string[]> = {};
  for (const issue of r.error.issues) {
    const key = issue.path.join('.') || '_';
    (fieldErrors[key] ??= []).push(issue.message);
  }
  throw invalid('Request validation failed', fieldErrors);
}

declare module 'fastify' {
  interface FastifyRequest {
    correlationId: string;
  }
}

const CORRELATION_RE = /^[A-Za-z0-9._-]{8,100}$/;

export function registerErrorHandling(app: FastifyInstance): void {
  app.decorateRequest('correlationId', '');
  app.addHook('onRequest', async (req: FastifyRequest, reply: FastifyReply) => {
    const header = req.headers['x-correlation-id'];
    req.correlationId = typeof header === 'string' && CORRELATION_RE.test(header) ? header : randomUUID();
    reply.header('x-correlation-id', req.correlationId);
  });

  app.setErrorHandler((err: unknown, req, reply) => {
    const correlation_id = req.correlationId || randomUUID();
    if (err instanceof AppError) {
      return reply.status(err.status).send({
        error: { code: err.code, message: err.message, field_errors: err.fieldErrors, correlation_id },
      });
    }
    const e = err as { statusCode?: number; code?: string; message?: string; validation?: unknown };
    if (e.statusCode && e.statusCode >= 400 && e.statusCode < 500) {
      const status = e.statusCode === 400 ? 422 : e.statusCode;
      return reply.status(status).send({
        error: { code: e.code ?? 'bad_request', message: e.message ?? 'Bad request', correlation_id },
      });
    }
    req.log.error({ err, correlation_id }, 'unhandled error');
    // A 5xx never implies the change was saved; clients reconcile via idempotency keys.
    return reply.status(500).send({
      error: { code: 'internal_error', message: 'The request could not be completed; it may not have been saved.', correlation_id },
    });
  });

  app.setNotFoundHandler((req, reply) =>
    reply.status(404).send({ error: { code: 'not_found', message: 'Route not found', correlation_id: req.correlationId } }),
  );
}
