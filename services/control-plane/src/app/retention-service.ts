import type { RetentionPolicy } from '../domain/entities';
import { NotFoundError } from '../domain/errors';
import type { TenantContext } from '../domain/tenant-context';
import { assertCan } from './authorize';
import type { RetentionRepository } from './ports';

export interface UpsertRetentionCommand {
  hotDays: number;
  coldDays: number;
}

// RetentionService reads/writes the per-tenant retention policy (1:1 with tenant).
// Reads are allowed to members; writes are tenant_admin only. Both run under the
// tenant's RLS scope.
export class RetentionService {
  constructor(private readonly retention: RetentionRepository) {}

  async get(ctx: TenantContext): Promise<RetentionPolicy> {
    assertCan(ctx, 'retention:read');
    const policy = await this.retention.get(ctx.tenantId);
    if (!policy) {
      throw new NotFoundError('retention policy not found');
    }
    return policy;
  }

  async upsert(ctx: TenantContext, cmd: UpsertRetentionCommand): Promise<RetentionPolicy> {
    assertCan(ctx, 'retention:update');
    return this.retention.upsert(ctx.tenantId, {
      hotDays: cmd.hotDays,
      coldDays: cmd.coldDays,
      updatedBy: ctx.principalId,
    });
  }
}
