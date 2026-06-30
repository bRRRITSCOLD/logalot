import { describe, expect, it, vi } from 'vitest';
import { InviteService } from '../../src/app/invite-service';
import type {
  Clock,
  EmailSender,
  InviteAuditLogger,
  InviteRepository,
  NewInvite,
  SecretGenerator,
  TenantRepository,
} from '../../src/app/ports';
import type { ConsumedInvite, Invite, InviteRef, Tenant } from '../../src/domain/entities';
import { ConflictError, ForbiddenError, NotFoundError } from '../../src/domain/errors';
import type { TenantContext } from '../../src/domain/tenant-context';

// ── Fixtures ──────────────────────────────────────────────────────────────────

const TENANT_ID = '00000000-0000-0000-0000-00000000000a';
const TENANT_PUBLIC_ID = 'acme';
const PRINCIPAL_ID = '00000000-0000-0000-0000-0000000000c1';

const FIXED_NOW = new Date('2025-01-01T00:00:00.000Z');
// 64 hex chars = 32 bytes of CSPRNG secret.
const FIXED_SECRET = 'a'.repeat(64);
const FIXED_EXPIRES_AT = new Date(FIXED_NOW.getTime() + 604800 * 1000); // 7 days

function ctx(role: TenantContext['role']): TenantContext {
  return { tenantId: TENANT_ID, principalId: PRINCIPAL_ID, role };
}

function makeTenant(): Tenant {
  return {
    id: TENANT_ID,
    publicId: TENANT_PUBLIC_ID,
    name: 'Acme',
    status: 'active',
    createdAt: FIXED_NOW,
    updatedAt: FIXED_NOW,
  };
}

// ── Fakes ─────────────────────────────────────────────────────────────────────

class FakeInviteRepo implements InviteRepository {
  private rows = new Map<string, Invite>();
  private seq = 0;
  pendingCount = 0;

  async countPending(_tenantId: string): Promise<number> {
    return this.pendingCount;
  }

  async create(_tenantId: string, input: NewInvite): Promise<Invite> {
    const id = `invite-${++this.seq}`;
    const invite: Invite = {
      id,
      tenantId: _tenantId,
      email: input.email,
      role: input.role,
      status: 'pending',
      invitedBy: input.invitedBy,
      expiresAt: input.expiresAt,
      consumedAt: null,
      createdAt: FIXED_NOW,
      updatedAt: FIXED_NOW,
    };
    this.rows.set(id, invite);
    return invite;
  }

  async findValidByTokenHash(
    _tenantId: string,
    _tokenHash: Buffer,
    _now: Date,
  ): Promise<InviteRef | null> {
    return null;
  }

  async consume(
    _tenantId: string,
    _input: { tokenHash: Buffer; email: string; now: Date },
  ): Promise<ConsumedInvite | null> {
    return null;
  }

  async listByTenant(tenantId: string): Promise<Invite[]> {
    return [...this.rows.values()].filter((r) => r.tenantId === tenantId);
  }

  async revoke(tenantId: string, id: string, _now: Date): Promise<boolean> {
    const r = this.rows.get(id);
    if (!r || r.tenantId !== tenantId || r.status !== 'pending') return false;
    this.rows.set(id, { ...r, status: 'revoked' });
    return true;
  }
}

class FakeTenantRepo implements Partial<TenantRepository> {
  private tenant: Tenant | null;

  constructor(tenant: Tenant | null = makeTenant()) {
    this.tenant = tenant;
  }

  async findById(_id: string): Promise<Tenant | null> {
    return this.tenant;
  }

  // Stub out the rest to satisfy the interface type in tests — only findById is called.
  async create(): Promise<Tenant> { throw new Error('not used'); }
  async list(): Promise<Tenant[]> { return []; }
  async findByPublicId(): Promise<Tenant | null> { return null; }
  async update(): Promise<Tenant | null> { return null; }
  async delete(): Promise<boolean> { return false; }
}

class ThrowingEmailSender implements EmailSender {
  async send(): Promise<void> {
    throw new Error('SMTP connection refused');
  }
}

class NoOpEmailSender implements EmailSender {
  readonly calls: Array<{ to: string }> = [];
  async send(msg: { to: string; subject: string; text: string; html?: string }): Promise<void> {
    this.calls.push({ to: msg.to });
  }
}

// ── Factory ───────────────────────────────────────────────────────────────────

interface Deps {
  repo: FakeInviteRepo;
  tenants: FakeTenantRepo;
  generator: SecretGenerator;
  clock: Clock;
  emailSender: EmailSender;
  auditLogger: InviteAuditLogger;
}

function buildService(overrides: Partial<Deps> = {}): {
  svc: InviteService;
  deps: Deps;
} {
  const deps: Deps = {
    repo: overrides.repo ?? new FakeInviteRepo(),
    tenants: overrides.tenants ?? new FakeTenantRepo(),
    generator: overrides.generator ?? { generate: () => FIXED_SECRET },
    clock: overrides.clock ?? { now: () => FIXED_NOW },
    emailSender: overrides.emailSender ?? new NoOpEmailSender(),
    auditLogger: overrides.auditLogger ?? { log: vi.fn() },
  };
  const svc = new InviteService(
    deps.repo,
    deps.tenants as TenantRepository,
    deps.generator,
    deps.clock,
    deps.emailSender,
    deps.auditLogger,
    {
      inviteTtlSeconds: 604800, // 7 days
      inviteMaxOutstandingPerTenant: 50,
      inviteAcceptBaseUrl: 'http://localhost:5173',
    },
  );
  return { svc, deps };
}

// ── Tests ─────────────────────────────────────────────────────────────────────

describe('InviteService.create', () => {
  it('R-INV-2/12: returns invite + plaintext inviteUrl; stores only hash (no plaintext in record)', async () => {
    const { svc } = buildService();
    const result = await svc.create(ctx('tenant_admin'), {
      email: 'Alice@Example.Com', // uppercase — must be normalized
      role: 'member',
    });

    expect(result.invite).toBeDefined();
    expect(result.invite.email).toBe('alice@example.com'); // normalized
    expect(result.invite.status).toBe('pending');
    expect(result.inviteUrl).toContain('lginv_');
    expect(result.inviteUrl).toContain('/invite/accept?token=');
    // The record must never carry the secret or hash.
    expect(Object.keys(result.invite)).not.toContain('secretHash');
    expect(Object.keys(result.invite)).not.toContain('token_hash');
  });

  it('R-INV-12: inviteUrl contains the assembled plaintext token including tenant publicId', async () => {
    const { svc } = buildService();
    const result = await svc.create(ctx('tenant_admin'), { email: 'bob@example.com', role: 'member' });

    // Token format: lginv_<publicId>_<secret>
    expect(result.inviteUrl).toContain(`lginv_${TENANT_PUBLIC_ID}_${FIXED_SECRET}`);
  });

  it('R-INV-9: emits invite_created audit with inviteId + actorId, never the token', async () => {
    const logSpy = vi.fn();
    const { svc } = buildService({ auditLogger: { log: logSpy } });
    const result = await svc.create(ctx('tenant_admin'), { email: 'carol@example.com', role: 'member' });

    expect(logSpy).toHaveBeenCalledOnce();
    const [evt] = logSpy.mock.calls[0] as Parameters<InviteAuditLogger['log']>;
    expect(evt.outcome).toBe('invite_created');
    expect(evt.inviteId).toBe(result.invite.id);
    expect(evt.actorId).toBe(PRINCIPAL_ID);
    expect(evt.tenantId).toBe(TENANT_ID);
    // Token must NEVER appear in the audit.
    expect(JSON.stringify(evt)).not.toContain(FIXED_SECRET);
    expect(JSON.stringify(evt)).not.toContain('lginv_');
  });

  it('R-INV-14: a throwing EmailSender does NOT fail create; inviteUrl is still returned', async () => {
    const { svc } = buildService({ emailSender: new ThrowingEmailSender() });
    const result = await svc.create(ctx('tenant_admin'), { email: 'dave@example.com', role: 'member' });

    expect(result.invite.id).toBeDefined();
    expect(result.inviteUrl).toBeDefined();
  });

  it('R-INV-14: EMAIL_PROVIDER=none (NoOp sender) still succeeds + audits send outcome', async () => {
    const emailSender = new NoOpEmailSender();
    const logSpy = vi.fn();
    const { svc } = buildService({ emailSender, auditLogger: { log: logSpy } });
    const result = await svc.create(ctx('tenant_admin'), { email: 'eve@example.com', role: 'member' });

    expect(result.inviteUrl).toBeDefined();
    // Email send was attempted with the correct recipient.
    expect(emailSender.calls[0]?.to).toBe('eve@example.com');
    // Audit record was still emitted.
    expect(logSpy).toHaveBeenCalledOnce();
  });

  it('R-INV-14: email recipient is the normalized invite email, not an arbitrary address', async () => {
    const emailSender = new NoOpEmailSender();
    const { svc } = buildService({ emailSender });
    await svc.create(ctx('tenant_admin'), { email: 'Frank@EXAMPLE.COM', role: 'admin' });

    expect(emailSender.calls[0]?.to).toBe('frank@example.com');
  });

  it('R-INV-10: create at cap+1 throws ConflictError; no row written', async () => {
    const repo = new FakeInviteRepo();
    repo.pendingCount = 50; // at the cap
    const { svc } = buildService({ repo });

    await expect(
      svc.create(ctx('tenant_admin'), { email: 'grace@example.com', role: 'member' }),
    ).rejects.toBeInstanceOf(ConflictError);

    // No row written.
    const list = await repo.listByTenant(TENANT_ID);
    expect(list).toHaveLength(0);
  });

  it('R-INV-7: member role cannot create invite (RBAC gate)', async () => {
    const { svc } = buildService();
    await expect(
      svc.create(ctx('member'), { email: 'hank@example.com', role: 'member' }),
    ).rejects.toBeInstanceOf(ForbiddenError);
  });

  it('R-INV-8: tenant_admin role is permitted to create invite', async () => {
    const { svc } = buildService();
    // Must not throw.
    const result = await svc.create(ctx('tenant_admin'), { email: 'iris@example.com', role: 'member' });
    expect(result.invite).toBeDefined();
  });

  it('throws NotFoundError when the tenant does not exist', async () => {
    const tenants = new FakeTenantRepo(null); // simulate deleted/missing tenant
    const { svc } = buildService({ tenants });
    await expect(
      svc.create(ctx('tenant_admin'), { email: 'jane@example.com', role: 'member' }),
    ).rejects.toBeInstanceOf(NotFoundError);
  });

  it('stamps expiresAt from config.inviteTtlSeconds', async () => {
    const { svc } = buildService();
    const result = await svc.create(ctx('tenant_admin'), { email: 'kim@example.com', role: 'member' });
    expect(result.invite.expiresAt).toEqual(FIXED_EXPIRES_AT);
  });
});

describe('InviteService.list', () => {
  it('R-INV-7: returns invite list for tenant_admin', async () => {
    const repo = new FakeInviteRepo();
    // Pre-seed two invites.
    await repo.create(TENANT_ID, {
      email: 'a@example.com',
      role: 'member',
      secretHash: Buffer.alloc(32),
      invitedBy: PRINCIPAL_ID,
      expiresAt: FIXED_EXPIRES_AT,
    });
    await repo.create(TENANT_ID, {
      email: 'b@example.com',
      role: 'admin',
      secretHash: Buffer.alloc(32),
      invitedBy: PRINCIPAL_ID,
      expiresAt: FIXED_EXPIRES_AT,
    });
    const { svc } = buildService({ repo });

    const list = await svc.list(ctx('tenant_admin'));
    expect(list).toHaveLength(2);
  });

  it('R-INV-7: member role is forbidden from listing invites', async () => {
    const { svc } = buildService();
    await expect(svc.list(ctx('member'))).rejects.toBeInstanceOf(ForbiddenError);
  });

  it('R-INV-7: platform_operator is forbidden from listing invites', async () => {
    const { svc } = buildService();
    await expect(svc.list(ctx('platform_operator'))).rejects.toBeInstanceOf(ForbiddenError);
  });
});

describe('InviteService.revoke', () => {
  it('R-INV-7: revokes a pending invite and emits invite_revoked audit', async () => {
    const repo = new FakeInviteRepo();
    const logSpy = vi.fn();
    const { svc } = buildService({ repo, auditLogger: { log: logSpy } });

    // Create an invite directly in the repo.
    const invite = await repo.create(TENANT_ID, {
      email: 'leo@example.com',
      role: 'member',
      secretHash: Buffer.alloc(32),
      invitedBy: PRINCIPAL_ID,
      expiresAt: FIXED_EXPIRES_AT,
    });

    await svc.revoke(ctx('tenant_admin'), invite.id);

    // Row is now revoked.
    const list = await repo.listByTenant(TENANT_ID);
    expect(list[0]?.status).toBe('revoked');

    // Audit emitted for invite_created... wait, for revoke we use the revoke audit:
    expect(logSpy).toHaveBeenCalledOnce();
    const [evt] = logSpy.mock.calls[0] as Parameters<InviteAuditLogger['log']>;
    expect(evt.outcome).toBe('invite_revoked');
    expect(evt.inviteId).toBe(invite.id);
    expect(evt.actorId).toBe(PRINCIPAL_ID);
    expect(evt.tenantId).toBe(TENANT_ID);
  });

  it('R-INV-15: revoke on a non-existent id throws NotFoundError (RLS = cross-tenant invisible = 404)', async () => {
    const { svc } = buildService();
    await expect(svc.revoke(ctx('tenant_admin'), 'no-such-id')).rejects.toBeInstanceOf(
      NotFoundError,
    );
  });

  it('R-INV-7: member role is forbidden from revoking invites', async () => {
    const { svc } = buildService();
    await expect(svc.revoke(ctx('member'), 'any-id')).rejects.toBeInstanceOf(ForbiddenError);
  });

  it('R-INV-7: platform_operator is forbidden from revoking invites', async () => {
    const { svc } = buildService();
    await expect(svc.revoke(ctx('platform_operator'), 'any-id')).rejects.toBeInstanceOf(
      ForbiddenError,
    );
  });
});
