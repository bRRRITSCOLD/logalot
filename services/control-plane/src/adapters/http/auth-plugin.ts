import type { FastifyReply, FastifyRequest, preHandlerHookHandler } from 'fastify';
import type { TokenService } from '../../app/ports';
import { UnauthorizedError } from '../../domain/errors';
import type { TenantContext } from '../../domain/tenant-context';

// Augment the Fastify request with the verified TenantContext. It is the single,
// trusted place tenancy is established for a request (built from the access JWT,
// never from the body) — exactly the edge-verification ADR-0007 describes.
declare module 'fastify' {
  interface FastifyRequest {
    tenantContext?: TenantContext;
  }
}

const BEARER = /^Bearer (.+)$/;

// makeAuthenticate returns a preHandler that verifies the access JWT's signature,
// issuer, audience, expiry, and type, then attaches the resulting TenantContext.
// A missing/invalid token fails closed with 401 before any handler runs.
export function makeAuthenticate(tokens: TokenService): preHandlerHookHandler {
  return async (req: FastifyRequest, _reply: FastifyReply): Promise<void> => {
    const header = req.headers.authorization;
    const match = header ? BEARER.exec(header) : null;
    if (!match) {
      throw new UnauthorizedError('missing bearer token');
    }
    const token = match[1] as string;
    let claims: { tenantId: string; principalId: string; role: TenantContext['role'] };
    try {
      claims = await tokens.verifyAccess(token);
    } catch {
      throw new UnauthorizedError('invalid or expired token');
    }
    req.tenantContext = {
      tenantId: claims.tenantId,
      principalId: claims.principalId,
      role: claims.role,
    };
  };
}

// requireTenantContext returns the verified context or fails closed. Used by route
// handlers after the authenticate preHandler has run.
export function requireTenantContext(req: FastifyRequest): TenantContext {
  if (!req.tenantContext) {
    throw new UnauthorizedError();
  }
  return req.tenantContext;
}
