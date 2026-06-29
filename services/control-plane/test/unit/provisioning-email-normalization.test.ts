// Verifies that both UserService.create and TenantService.provisionAdmin apply
// normalizeEmail before persisting so call-sites never need to normalize manually.
import { describe, expect, it } from 'vitest';
import { TenantService } from '../../src/app/tenant-service';
import { UserService } from '../../src/app/user-service';
import type { Tenant, User } from '../../src/domain/entities';
import type { TenantContext } from '../../src/domain/tenant-context';

// ── Minimal fakes ────────────────────────────────────────────────────────────

const TENANT_ID = '00000000-0000-0000-0000-000000000001';
const TENANT: Tenant = {
  id: TENANT_ID,
  publicId: 'acme',
  name: 'Acme',
  status: 'active',
  createdAt: new Date(),
  updatedAt: new Date(),
};

const makeUser = (email: string): User => ({
  id: 'user-1',
  tenantId: TENANT_ID,
  email,
  displayName: null,
  status: 'active',
  isPlatformOperator: false,
  role: 'tenant_admin',
  createdAt: new Date(),
  updatedAt: new Date(),
});

class FakeUserRepo {
  created: Array<{ tenantId: string; data: { email: string } }> = [];

  async create(
    tenantId: string,
    data: { email: string; passwordHash: string; displayName: string | null; role: string },
  ) {
    this.created.push({ tenantId, data });
    return makeUser(data.email);
  }

  async list() {
    return [];
  }
  async findById() {
    return null;
  }
  async update() {
    return null;
  }
  async delete() {
    return false;
  }
  async findCredentialsByEmail() {
    return null;
  }
  async findCredentialsById() {
    return null;
  }
}

class FakeTenantRepo {
  async findById(id: string): Promise<Tenant | null> {
    return id === TENANT_ID ? TENANT : null;
  }
  async create(data: { publicId: string; name: string }): Promise<Tenant> {
    return { ...TENANT, ...data };
  }
  async findByPublicId() {
    return TENANT;
  }
  async list() {
    return [TENANT];
  }
  async update() {
    return TENANT;
  }
  async delete() {
    return false;
  }
}

const fakeHasher = {
  async hash(plain: string) {
    return `hashed:${plain}`;
  },
  async verify() {
    return true;
  },
};

const operatorCtx: TenantContext = {
  tenantId: TENANT_ID,
  principalId: 'op-1',
  role: 'platform_operator',
};

const adminCtx: TenantContext = {
  tenantId: TENANT_ID,
  principalId: 'admin-1',
  role: 'tenant_admin',
};

// ── Tests ────────────────────────────────────────────────────────────────────

describe('UserService.create — email normalization', () => {
  it('stores the normalized email when raw email has mixed case and whitespace', async () => {
    const repo = new FakeUserRepo();
    const svc = new UserService(repo as never, fakeHasher);

    await svc.create(adminCtx, {
      email: '  User@Example.COM ',
      password: 'secret',
      role: 'member',
    });

    expect(repo.created[0]?.data.email).toBe('user@example.com');
  });

  it('is idempotent — pre-normalized input is unchanged', async () => {
    const repo = new FakeUserRepo();
    const svc = new UserService(repo as never, fakeHasher);

    await svc.create(adminCtx, {
      email: 'user@example.com',
      password: 'secret',
      role: 'member',
    });

    expect(repo.created[0]?.data.email).toBe('user@example.com');
  });
});

describe('TenantService.provisionAdmin — email normalization', () => {
  it('stores the normalized email when raw email has mixed case and whitespace', async () => {
    const userRepo = new FakeUserRepo();
    const tenantRepo = new FakeTenantRepo();
    const svc = new TenantService(tenantRepo as never, userRepo as never, fakeHasher);

    await svc.provisionAdmin(operatorCtx, TENANT_ID, {
      email: '  Admin@ACME.IO ',
      password: 'secret',
    });

    expect(userRepo.created[0]?.data.email).toBe('admin@acme.io');
  });

  it('is idempotent — pre-normalized input is unchanged', async () => {
    const userRepo = new FakeUserRepo();
    const tenantRepo = new FakeTenantRepo();
    const svc = new TenantService(tenantRepo as never, userRepo as never, fakeHasher);

    await svc.provisionAdmin(operatorCtx, TENANT_ID, {
      email: 'admin@acme.io',
      password: 'secret',
    });

    expect(userRepo.created[0]?.data.email).toBe('admin@acme.io');
  });
});
