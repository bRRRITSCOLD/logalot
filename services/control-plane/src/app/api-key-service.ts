import { mintApiKey } from '../domain/api-key';
import type { ApiKeyRecord } from '../domain/entities';
import { NotFoundError, ValidationError } from '../domain/errors';
import type { TenantContext } from '../domain/tenant-context';
import { assertCan } from './authorize';
import type { ApiKeyRepository, Clock, KeyMaterialGenerator, TenantRepository } from './ports';

export interface IssueApiKeyCommand {
  name: string;
  scopes?: string[];
  expiresAt?: Date | null;
}

// IssuedApiKey carries the one-time plaintext (shown to the admin exactly once,
// NEVER persisted) alongside the stored, non-secret record.
export interface IssuedApiKey {
  plaintext: string;
  record: ApiKeyRecord;
}

// DEFAULT_SCOPES is the scope set applied when no scopes are provided.
// ingest:write is the common case — most callers just want to push logs.
//
// Read-only consumers (dashboards, CI log viewers, etc.) should be issued
// ['logs:read'] explicitly. Since #82, ingest:write alone no longer grants
// log reads; keys that need both ingest and read must carry both scopes.
const DEFAULT_SCOPES = ['ingest:write'];

// ApiKeyService issues / lists / revokes tenant API keys (tenant_admin only). The
// minted key is byte-compatible with the Go ingest Authenticator: the plaintext is
// `lgk_<tenantSlug>_<keyId>_<secret>` and only sha256(secret) is stored (migration
// 000005). The tenant slug is resolved from the registry, never the request body.
export class ApiKeyService {
  constructor(
    private readonly keys: ApiKeyRepository,
    private readonly tenants: TenantRepository,
    private readonly generator: KeyMaterialGenerator,
    private readonly clock: Clock,
  ) {}

  async issue(ctx: TenantContext, cmd: IssueApiKeyCommand): Promise<IssuedApiKey> {
    assertCan(ctx, 'apikey:create');

    const tenant = await this.tenants.findById(ctx.tenantId);
    if (!tenant) {
      throw new NotFoundError('tenant not found');
    }

    const material = this.generator.generate();
    const minted = mintApiKey(tenant.publicId, material);
    const scopes = cmd.scopes && cmd.scopes.length > 0 ? cmd.scopes : DEFAULT_SCOPES;

    const record = await this.keys.create(ctx.tenantId, {
      keyId: minted.keyId,
      name: cmd.name,
      keyHash: minted.keyHash,
      scopes,
      createdBy: ctx.principalId,
      expiresAt: cmd.expiresAt ?? null,
    });

    return { plaintext: minted.plaintext, record };
  }

  async list(ctx: TenantContext): Promise<ApiKeyRecord[]> {
    assertCan(ctx, 'apikey:list');
    return this.keys.list(ctx.tenantId);
  }

  async revoke(ctx: TenantContext, keyId: string): Promise<void> {
    assertCan(ctx, 'apikey:revoke');
    if (!keyId) {
      throw new ValidationError('key id is required');
    }
    const revoked = await this.keys.revoke(ctx.tenantId, keyId, this.clock.now());
    if (!revoked) {
      throw new NotFoundError('api key not found');
    }
  }
}
