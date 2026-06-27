import { can, type Operation } from '../domain/rbac';
import { ForbiddenError } from '../domain/errors';
import type { TenantContext } from '../domain/tenant-context';

// assertCan re-asserts RBAC inside the application core (ADR-0007: authorization
// is checked at the edge AND re-asserted in the domain for sensitive commands).
// Single source: it consults the same matrix the HTTP route guard uses.
export function assertCan(ctx: TenantContext, operation: Operation): void {
  if (!can(ctx.role, operation)) {
    throw new ForbiddenError(`role '${ctx.role}' may not perform '${operation}'`);
  }
}
