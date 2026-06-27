import { beforeEach, describe, expect, it } from 'vitest';
import { type AuthDeps, AuthService } from '../../src/app/auth-service';
import type {
  AuthRecord,
  NewRefreshToken,
  RefreshTokenRow,
  SessionClaims,
} from '../../src/app/ports';
import type { Tenant } from '../../src/domain/entities';
import { UnauthorizedError } from '../../src/domain/errors';

const TENANT: Tenant = {
  id: '00000000-0000-0000-0000-0000000000a1',
  publicId: 'acme',
  name: 'Acme',
  status: 'active',
  createdAt: new Date(),
  updatedAt: new Date(),
};

// ── Minimal in-memory fakes for the AuthService's ports. They model behavior, not
// storage details — RLS isolation is proven separately in the integration suite.

class FakeTenantRepo {
  constructor(private readonly tenants: Tenant[]) {}
  async findByPublicId(slug: string): Promise<Tenant | null> {
    return this.tenants.find((t) => t.publicId === slug) ?? null;
  }
  async findById(id: string): Promise<Tenant | null> {
    return this.tenants.find((t) => t.id === id) ?? null;
  }
}

class FakeUserRepo {
  constructor(private readonly byEmail: Map<string, AuthRecord>) {}
  async findCredentialsByEmail(_tenantId: string, email: string): Promise<AuthRecord | null> {
    return this.byEmail.get(email) ?? null;
  }
  async findCredentialsById(_tenantId: string, id: string): Promise<AuthRecord | null> {
    for (const rec of this.byEmail.values()) {
      if (rec.id === id) {
        return rec;
      }
    }
    return null;
  }
}

class FakeRefreshRepo {
  rows = new Map<string, RefreshTokenRow>();
  private seq = 0;
  async create(_tenantId: string, input: NewRefreshToken): Promise<{ id: string }> {
    const id = `tok-${++this.seq}`;
    this.rows.set(id, {
      id,
      userId: input.userId,
      familyId: input.familyId,
      tokenHash: input.tokenHash,
      expiresAt: input.expiresAt,
      rotatedAt: null,
      revokedAt: null,
    });
    return { id };
  }
  async findById(_tenantId: string, id: string): Promise<RefreshTokenRow | null> {
    return this.rows.get(id) ?? null;
  }
  async rotate(
    _tenantId: string,
    presentedId: string,
    now: Date,
    successor: NewRefreshToken,
  ): Promise<{ id: string } | null> {
    const row = this.rows.get(presentedId);
    // Atomic check-and-set: the check and the rotated_at write happen with no
    // intervening await, so two concurrent presentations cannot both consume the
    // token — exactly the SQL conditional UPDATE's guarantee, in miniature.
    if (!row || row.rotatedAt !== null || row.revokedAt !== null) {
      return null;
    }
    row.rotatedAt = now;
    return this.create(_tenantId, successor);
  }
  async revokeFamily(_tenantId: string, familyId: string, now: Date): Promise<void> {
    for (const row of this.rows.values()) {
      if (row.familyId === familyId && row.revokedAt === null) {
        row.revokedAt = now;
      }
    }
  }
}

const fakeHasher = {
  async hash(p: string): Promise<string> {
    return `hash:${p}`;
  },
  async verify(p: string, h: string): Promise<boolean> {
    return h === `hash:${p}`;
  },
};

const fakeTokens = {
  async issueAccess(claims: SessionClaims): Promise<{ token: string; expiresInSeconds: number }> {
    return { token: `access:${claims.principalId}:${claims.role}`, expiresInSeconds: 900 };
  },
  async verifyAccess(): Promise<SessionClaims> {
    throw new Error('unused');
  },
};

function buildDeps(): { deps: AuthDeps; refresh: FakeRefreshRepo; tenant: Tenant } {
  const refresh = new FakeRefreshRepo();
  let secretSeq = 0;
  let idSeq = 0;
  // Fresh per-call clone so a test mutating status (suspension) never leaks.
  const tenant: Tenant = { ...TENANT };
  const deps: AuthDeps = {
    tenants: new FakeTenantRepo([tenant]) as unknown as AuthDeps['tenants'],
    users: new FakeUserRepo(
      new Map<string, AuthRecord>([
        [
          'admin@acme.co',
          { id: 'user-1', passwordHash: 'hash:pw', status: 'active', role: 'tenant_admin' },
        ],
        [
          'off@acme.co',
          { id: 'user-2', passwordHash: 'hash:pw', status: 'suspended', role: 'member' },
        ],
      ]),
    ) as unknown as AuthDeps['users'],
    refreshTokens: refresh as unknown as AuthDeps['refreshTokens'],
    hasher: fakeHasher,
    tokens: fakeTokens,
    secrets: { generate: () => `secret-${++secretSeq}` },
    ids: { uuid: () => `fam-${++idSeq}` },
    clock: { now: () => new Date('2026-06-27T00:00:00Z') },
    refreshTtlSeconds: 3600,
  };
  return { deps, refresh, tenant };
}

describe('AuthService', () => {
  let service: AuthService;
  let refresh: FakeRefreshRepo;
  let tenant: Tenant;

  beforeEach(() => {
    const built = buildDeps();
    service = new AuthService(built.deps);
    refresh = built.refresh;
    tenant = built.tenant;
  });

  it('logs in with valid credentials and returns an enriched Bearer session', async () => {
    const session = await service.login({
      tenantSlug: 'acme',
      email: 'admin@acme.co',
      password: 'pw',
    });
    expect(session.tokenType).toBe('Bearer');
    expect(session.expiresIn).toBe(900);
    expect(session.role).toBe('tenant_admin');
    expect(session.tenantId).toBe(TENANT.id);
    expect(session.userId).toBe('user-1');
    expect(session.accessToken).toBe('access:user-1:tenant_admin');
    expect(session.refreshToken).toBe(`lgr_${TENANT.id}_tok-1_secret-1`);
  });

  it('rejects a wrong password', async () => {
    await expect(
      service.login({ tenantSlug: 'acme', email: 'admin@acme.co', password: 'nope' }),
    ).rejects.toBeInstanceOf(UnauthorizedError);
  });

  it('rejects an unknown tenant', async () => {
    await expect(
      service.login({ tenantSlug: 'ghost', email: 'admin@acme.co', password: 'pw' }),
    ).rejects.toBeInstanceOf(UnauthorizedError);
  });

  it('rejects a suspended user', async () => {
    await expect(
      service.login({ tenantSlug: 'acme', email: 'off@acme.co', password: 'pw' }),
    ).rejects.toBeInstanceOf(UnauthorizedError);
  });

  it('rotates the refresh token and detects reuse of the old one (family revoke)', async () => {
    const first = await service.login({
      tenantSlug: 'acme',
      email: 'admin@acme.co',
      password: 'pw',
    });
    const second = await service.refresh(first.refreshToken);
    expect(second.refreshToken).not.toBe(first.refreshToken);

    // Reuse of the rotated token is rejected AND revokes the whole family...
    await expect(service.refresh(first.refreshToken)).rejects.toBeInstanceOf(UnauthorizedError);
    // ...so even the rotated successor is now dead (theft mitigation).
    await expect(service.refresh(second.refreshToken)).rejects.toBeInstanceOf(UnauthorizedError);
  });

  it('logout revokes the family so the refresh token no longer works', async () => {
    const session = await service.login({
      tenantSlug: 'acme',
      email: 'admin@acme.co',
      password: 'pw',
    });
    await service.logout(session.refreshToken);
    await expect(service.refresh(session.refreshToken)).rejects.toBeInstanceOf(UnauthorizedError);
  });

  it('rejects an expired refresh token', async () => {
    const session = await service.login({
      tenantSlug: 'acme',
      email: 'admin@acme.co',
      password: 'pw',
    });
    for (const row of refresh.rows.values()) {
      row.expiresAt = new Date('2020-01-01T00:00:00Z');
    }
    await expect(service.refresh(session.refreshToken)).rejects.toBeInstanceOf(UnauthorizedError);
  });

  it('rejects refresh when the tenant is no longer active (suspended/deleted)', async () => {
    const session = await service.login({
      tenantSlug: 'acme',
      email: 'admin@acme.co',
      password: 'pw',
    });
    // Suspending the tenant must immediately bar refresh (login already bars it).
    tenant.status = 'suspended';
    await expect(service.refresh(session.refreshToken)).rejects.toBeInstanceOf(UnauthorizedError);
    // The family is revoked, so even re-activation would not resurrect the session.
    tenant.status = 'active';
    await expect(service.refresh(session.refreshToken)).rejects.toBeInstanceOf(UnauthorizedError);
  });

  it('concurrent refresh with the same token: exactly one succeeds, family revoked', async () => {
    const session = await service.login({
      tenantSlug: 'acme',
      email: 'admin@acme.co',
      password: 'pw',
    });
    // Two simultaneous presentations of the SAME refresh token. The atomic
    // consume (rotate) must let exactly one win; the other is treated as reuse.
    const results = await Promise.allSettled([
      service.refresh(session.refreshToken),
      service.refresh(session.refreshToken),
    ]);
    const fulfilled = results.filter((r) => r.status === 'fulfilled');
    const rejected = results.filter((r) => r.status === 'rejected');
    expect(fulfilled).toHaveLength(1);
    expect(rejected).toHaveLength(1);
    // Reuse detection revoked the family, so the freshly minted successor is dead.
    const winner = (fulfilled[0] as PromiseFulfilledResult<{ refreshToken: string }>).value;
    await expect(service.refresh(winner.refreshToken)).rejects.toBeInstanceOf(UnauthorizedError);
  });
});
