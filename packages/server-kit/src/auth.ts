import { createLocalJWKSet, createRemoteJWKSet, jwtVerify, type JSONWebKeySet, type JWTPayload } from 'jose';
import type { AccessTokenClaims } from '@vm/contracts';
import { unauthorized } from './errors.ts';

export interface TokenVerifierOptions {
  issuer: string;
  audience: string;
  jwksUrl?: string;
  jwks?: JSONWebKeySet;
}

export type VerifiedClaims = AccessTokenClaims & JWTPayload;

export type TokenVerifier = (authorization: string | undefined) => Promise<VerifiedClaims>;

export function createTokenVerifier(opts: TokenVerifierOptions): TokenVerifier {
  const keys = opts.jwks
    ? createLocalJWKSet(opts.jwks)
    : opts.jwksUrl
      ? createRemoteJWKSet(new URL(opts.jwksUrl), { cooldownDuration: 30_000, cacheMaxAge: 10 * 60_000 })
      : null;
  if (!keys) throw new Error('Token verifier requires jwks or jwksUrl');
  return async (authorization) => {
    if (!authorization?.startsWith('Bearer ')) throw unauthorized();
    const token = authorization.slice(7).trim();
    try {
      const { payload } = await jwtVerify(token, keys, {
        issuer: opts.issuer,
        audience: opts.audience,
        algorithms: ['ES256'],
        clockTolerance: 30,
      });
      const p = payload as Partial<VerifiedClaims>;
      if (typeof p.sub !== 'string' || typeof p.tid !== 'string' || !Array.isArray(p.sites)) {
        throw unauthorized('Token is missing required claims');
      }
      return {
        ...payload,
        sub: p.sub,
        tid: p.tid,
        kind: p.kind === 'service' ? 'service' : 'human',
        name: typeof p.name === 'string' ? p.name : p.sub,
        email: typeof p.email === 'string' ? p.email : undefined,
        sites: p.sites.filter((s): s is string => typeof s === 'string'),
        proles: Array.isArray(p.proles) ? p.proles : [],
      };
    } catch (err) {
      if ((err as { status?: number }).status === 401) throw err;
      throw unauthorized('Invalid or expired token');
    }
  };
}
