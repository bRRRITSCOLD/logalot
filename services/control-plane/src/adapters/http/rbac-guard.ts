import type { FastifyRequest, preHandlerHookHandler } from 'fastify';
import { ForbiddenError } from '../../domain/errors';
import { can, type Operation } from '../../domain/rbac';
import { requireTenantContext } from './auth-plugin';

// makeRequireOperation returns a preHandler that enforces the RBAC matrix at the
// EDGE (the first of the two defense-in-depth checks; the application service
// re-asserts the same matrix). Runs after authenticate, so a TenantContext exists.
export function makeRequireOperation(operation: Operation): preHandlerHookHandler {
  return async (req: FastifyRequest): Promise<void> => {
    const ctx = requireTenantContext(req);
    if (!can(ctx.role, operation)) {
      throw new ForbiddenError(`role '${ctx.role}' may not perform '${operation}'`);
    }
  };
}
