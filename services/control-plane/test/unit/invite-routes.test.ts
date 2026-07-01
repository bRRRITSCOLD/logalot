import { createHash, randomUUID } from 'node:crypto';
import { inviteListSchema } from '@logalot/contracts';
import type { FastifyInstance } from 'fastify';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { buildServer } from '../../src/adapters/http/server';
import type { OidcAuthenticator } from '../../src/app/oidc-authenticator';
import type { TokenService } from '../../src/app/ports';
import type { Services } from '../../src/container';

// ── Minimal stubs ──────────────────────────────────────────────────────────────
//
// The invite service is fully stubbed — these tests exercise the HTTP layer
// (RBAC guards, request parsing, rate-limiting, logging), not InviteService itself.

const TENANT_ID = randomUUID();
const USER_ID = randomUUID();
const INVITE_ID = randomUUID();

const FIXED_NOW = new Date('2025-06-01T00:00:00.000Z');
const FIXED_EXPIRES = new Date('2025-06-08T00:00:00.000Z');

function makeInvite() {
  return {
    id: INVITE_ID,
    tenantId: TENANT_ID,
    email: 'user@example.com',
    role: 'member',
    status: 'pending' as const,
    createdBy: USER_ID,
    expiresAt: FIXED_EXPIRES,
    consumedAt: null,
    createdAt: FIXED_NOW,
    updatedAt: FIXED_NOW,
  };
}

function makeStubInviteService(overrides: Partial<Services['invites']> = {}): Services['invites'] {
  return {
    create: vi.fn().mockResolvedValue({
      invite: makeInvite(),
      inviteUrl: 'https://app.example.com/invite/accept?token=abc123',
    }),
    list: vi.fn().mockResolvedValue([makeInvite()]),
    revoke: vi.fn().mockResolvedValue(undefined),
    ...overrides,
  } as unknown as Services['invites'];
}

function makeStubServices(invites: Services['invites'] = makeStubInviteService()): Services {
  const notImpl = () => Promise.reject(new Error('stub'));
  return {
    auth: { login: notImpl, refresh: notImpl, logout: notImpl } as unknown as Services['auth'],
    tenants: {} as unknown as Services['tenants'],
    users: {} as unknown as Services['users'],
    apiKeys: {} as unknown as Services['apiKeys'],
    retention: {} as unknown as Services['retention'],
    alerts: {} as unknown as Services['alerts'],
    savedQueries: {} as unknown as Services['savedQueries'],
    dashboards: {} as unknown as Services['dashboards'],
    invites,
  };
}

// makeStubTokenService returns a token service where verifyAccess resolves to a
// valid TenantContext when given a known role-tagged token, enabling RBAC tests.
// Roles must match the domain Role type: 'tenant_admin', 'member', 'platform_operator'.
function makeStubTokenService(
  role: 'tenant_admin' | 'member' | 'platform_operator' | null = 'tenant_admin',
): TokenService {
  return {
    issueAccess: vi.fn(),
    verifyAccess: vi.fn().mockImplementation((token: string) => {
      if (token === 'no-token' || role === null) {
        return Promise.reject(new Error('invalid token'));
      }
      return Promise.resolve({
        tenantId: TENANT_ID,
        principalId: USER_ID,
        role,
      });
    }),
  };
}

function makeStubOidcAuthenticator(): OidcAuthenticator {
  return {
    beginAuthorize: vi.fn().mockResolvedValue({ redirectUrl: 'https://accounts.google.com/auth' }),
    handleCallback: vi.fn().mockResolvedValue({
      tokens: {
        accessToken: 'access',
        refreshToken: 'refresh',
        expiresIn: 900,
        tokenType: 'Bearer',
        role: 'member',
        tenantId: TENANT_ID,
        userId: USER_ID,
      },
      returnTo: '/',
    }),
  } as unknown as OidcAuthenticator;
}

function auth(token: string) {
  return { authorization: `Bearer ${token}` };
}

function makeCaptureStream(): { stream: { write(msg: string): void }; lines: string[] } {
  const lines: string[] = [];
  return {
    lines,
    stream: {
      write(msg: string) {
        lines.push(msg.trim());
      },
    },
  };
}

async function buildTestServer(
  opts: {
    role?: 'tenant_admin' | 'member' | 'platform_operator' | null;
    invites?: Services['invites'];
    oidcRateLimitMax?: number;
    logger?: false | { level: string; stream: { write(msg: string): void } };
  } = {},
): Promise<FastifyInstance> {
  const inviteService = opts.invites ?? makeStubInviteService();
  const app = buildServer({
    services: makeStubServices(inviteService),
    tokenService: makeStubTokenService(opts.role ?? 'tenant_admin'),
    oidcAuthenticator: makeStubOidcAuthenticator(),
    ping: async () => true,
    logger: opts.logger ?? false,
    trustProxy: false,
    oidcRateLimitMax: opts.oidcRateLimitMax ?? 100,
    oidcRateLimitWindowMs: 60_000,
  });
  await app.ready();
  return app;
}

// ── RBAC tests (R-INV-7) ──────────────────────────────────────────────────────

describe('invite routes: RBAC (R-INV-7)', () => {
  let adminApp: FastifyInstance;
  let memberApp: FastifyInstance;
  let unauthApp: FastifyInstance;

  beforeAll(async () => {
    adminApp = await buildTestServer({ role: 'tenant_admin' });
    memberApp = await buildTestServer({ role: 'member' });
    unauthApp = await buildTestServer({ role: null });
  });

  afterAll(async () => {
    await adminApp.close();
    await memberApp.close();
    await unauthApp.close();
  });

  describe('POST /v1/invites', () => {
    const payload = { email: 'new@example.com', role: 'member' };

    it('returns 201 for tenant_admin', async () => {
      const res = await adminApp.inject({
        method: 'POST',
        url: '/v1/invites',
        headers: auth('valid-token'),
        payload,
      });
      expect(res.statusCode).toBe(201);
    });

    it('returns 403 for member (R-INV-7)', async () => {
      const res = await memberApp.inject({
        method: 'POST',
        url: '/v1/invites',
        headers: auth('valid-token'),
        payload,
      });
      expect(res.statusCode).toBe(403);
    });

    it('returns 401 for unauthenticated request', async () => {
      const res = await unauthApp.inject({
        method: 'POST',
        url: '/v1/invites',
        headers: auth('no-token'),
        payload,
      });
      expect(res.statusCode).toBe(401);
    });
  });

  describe('GET /v1/invites', () => {
    it('returns 200 for tenant_admin', async () => {
      const res = await adminApp.inject({
        method: 'GET',
        url: '/v1/invites',
        headers: auth('valid-token'),
      });
      expect(res.statusCode).toBe(200);
      expect(res.json()).toHaveProperty('invites');
    });

    // Intent: a non-empty list response must parse against the SAME contract
    // schema the web BFF uses, so the projection can't drift to `invitedBy`.
    it('InviteRoutes_ListNonEmpty_ResponseConformsToSharedContract', async () => {
      // Regression: the projection drifted to `invitedBy` while the shared
      // contract (consumed by the web BFF) requires `createdBy`. A non-empty
      // list then failed the BFF's Zod parse — "invites won't load". This test
      // parses the wire response with the SAME schema the BFF uses, so the two
      // sides can never diverge again.
      const res = await adminApp.inject({
        method: 'GET',
        url: '/v1/invites',
        headers: auth('valid-token'),
      });
      const parsed = inviteListSchema.safeParse(res.json());
      expect(parsed.success, JSON.stringify(parsed.error?.issues)).toBe(true);
    });

    it('returns 403 for member (R-INV-7)', async () => {
      const res = await memberApp.inject({
        method: 'GET',
        url: '/v1/invites',
        headers: auth('valid-token'),
      });
      expect(res.statusCode).toBe(403);
    });

    it('returns 401 for unauthenticated request', async () => {
      const res = await unauthApp.inject({
        method: 'GET',
        url: '/v1/invites',
        headers: auth('no-token'),
      });
      expect(res.statusCode).toBe(401);
    });
  });

  describe('POST /v1/invites/:id/revoke', () => {
    it('returns 204 for tenant_admin', async () => {
      const res = await adminApp.inject({
        method: 'POST',
        url: `/v1/invites/${INVITE_ID}/revoke`,
        headers: auth('valid-token'),
      });
      expect(res.statusCode).toBe(204);
    });

    it('returns 403 for member (R-INV-7)', async () => {
      const res = await memberApp.inject({
        method: 'POST',
        url: `/v1/invites/${INVITE_ID}/revoke`,
        headers: auth('valid-token'),
      });
      expect(res.statusCode).toBe(403);
    });

    it('returns 401 for unauthenticated request', async () => {
      const res = await unauthApp.inject({
        method: 'POST',
        url: `/v1/invites/${INVITE_ID}/revoke`,
        headers: auth('no-token'),
      });
      expect(res.statusCode).toBe(401);
    });
  });
});

// ── Create happy path (returns inviteUrl) ─────────────────────────────────────

describe('POST /v1/invites: happy path', () => {
  let app: FastifyInstance;
  let inviteService: Services['invites'];

  beforeAll(async () => {
    inviteService = makeStubInviteService();
    app = await buildTestServer({ invites: inviteService });
  });

  afterAll(async () => {
    await app.close();
  });

  it('returns 201 with invite fields and one-time inviteUrl', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/v1/invites',
      headers: auth('valid-token'),
      payload: { email: 'new@example.com', role: 'member' },
    });
    expect(res.statusCode).toBe(201);
    const body = res.json<{ id: string; inviteUrl: string; status: string }>();
    expect(body.id).toBe(INVITE_ID);
    expect(body.status).toBe('pending');
    expect(body.inviteUrl).toBe('https://app.example.com/invite/accept?token=abc123');
  });

  it('calls InviteService.create with parsed email and role', async () => {
    await app.inject({
      method: 'POST',
      url: '/v1/invites',
      headers: auth('valid-token'),
      payload: { email: 'other@example.com', role: 'admin' },
    });
    expect(inviteService.create).toHaveBeenCalledWith(
      expect.objectContaining({ tenantId: TENANT_ID }),
      { email: 'other@example.com', role: 'admin' },
    );
  });
});

// ── Rate-limit on POST /v1/invites (R-INV-10) ────────────────────────────────

describe('POST /v1/invites: rate limit (R-INV-10)', () => {
  it('returns 429 after exceeding per-IP threshold', async () => {
    const app = await buildTestServer({ oidcRateLimitMax: 2 });

    try {
      const payload = { email: 'ratelimit@example.com', role: 'member' };
      const headers = auth('valid-token');

      // First two requests consume the budget.
      await app.inject({ method: 'POST', url: '/v1/invites', headers, payload });
      await app.inject({ method: 'POST', url: '/v1/invites', headers, payload });

      // Third request should be rate-limited.
      const res = await app.inject({ method: 'POST', url: '/v1/invites', headers, payload });
      expect(res.statusCode).toBe(429);
      const body = res.json<{ error: string }>();
      expect(body.error).toBe('rate_limit_exceeded');
    } finally {
      await app.close();
    }
  });
});

// ── Callback inviteToken hash threading (ADR-0012, R-INV-12) ─────────────────

describe('POST /v1/auth/oidc/google/callback: inviteToken hash threading', () => {
  it('passes SHA-256 hash (32 bytes) of inviteToken to handleCallback', async () => {
    const oidcAuthenticator = makeStubOidcAuthenticator();
    const app = buildServer({
      services: makeStubServices(),
      tokenService: makeStubTokenService(),
      oidcAuthenticator,
      ping: async () => true,
      logger: false,
      trustProxy: false,
      oidcRateLimitMax: 100,
      oidcRateLimitWindowMs: 60_000,
    });
    await app.ready();

    // Wire format: `lginv_<tenantPublicId>_<secret>` (domain/invite.ts). Only the
    // SECRET is hashed — that's what invites.token_hash stores (InviteService
    // hashes the secret alone via hashInviteSecret, never the assembled string).
    const secret = 'a'.repeat(64);
    const plaintext = `lginv_acme_${secret}`;
    const expectedHash = createHash('sha256').update(secret, 'utf8').digest();

    try {
      await app.inject({
        method: 'POST',
        url: '/v1/auth/oidc/google/callback',
        payload: {
          tenantSlug: 'acme',
          code: 'auth-code',
          state: 'state-value',
          inviteToken: plaintext,
        },
      });

      expect(oidcAuthenticator.handleCallback).toHaveBeenCalledWith(
        expect.objectContaining({
          inviteTokenHash: expectedHash,
        }),
      );
      // Verify the hash is exactly 32 bytes (SHA-256 raw bytes = R-INV-12).
      const call = vi.mocked(oidcAuthenticator.handleCallback).mock.calls[0];
      const passedHash = call?.[0].inviteTokenHash;
      expect(passedHash).toBeInstanceOf(Buffer);
      expect((passedHash as Buffer).length).toBe(32);
    } finally {
      await app.close();
    }
  });

  it('passes undefined inviteTokenHash when inviteToken is absent (normal login)', async () => {
    const oidcAuthenticator = makeStubOidcAuthenticator();
    const app = buildServer({
      services: makeStubServices(),
      tokenService: makeStubTokenService(),
      oidcAuthenticator,
      ping: async () => true,
      logger: false,
      trustProxy: false,
      oidcRateLimitMax: 100,
      oidcRateLimitWindowMs: 60_000,
    });
    await app.ready();

    try {
      await app.inject({
        method: 'POST',
        url: '/v1/auth/oidc/google/callback',
        payload: { tenantSlug: 'acme', code: 'auth-code', state: 'state-value' },
      });

      expect(oidcAuthenticator.handleCallback).toHaveBeenCalledWith(
        expect.objectContaining({ inviteTokenHash: undefined }),
      );
    } finally {
      await app.close();
    }
  });
});

// ── No PII in logs (R-INV-12) ─────────────────────────────────────────────────

describe('invite routes + callback: no plaintext token in logs (R-INV-12)', () => {
  it('create and callback emit no raw inviteToken or inviteUrl in structured logs', async () => {
    const { stream, lines } = makeCaptureStream();
    const inviteService = makeStubInviteService();
    const oidcAuthenticator = makeStubOidcAuthenticator();
    const rawInviteToken = `lginv_acme_${'b'.repeat(64)}`;
    const rawInviteUrl = 'https://app.example.com/invite/accept?token=should-not-appear';

    // Override create to return a URL with distinct sentinel string.
    vi.mocked(inviteService.create).mockResolvedValue({
      invite: makeInvite(),
      inviteUrl: rawInviteUrl,
    });

    const app = buildServer({
      services: makeStubServices(inviteService),
      tokenService: makeStubTokenService('tenant_admin'),
      oidcAuthenticator,
      ping: async () => true,
      logger: { level: 'info', stream },
      trustProxy: false,
      oidcRateLimitMax: 100,
      oidcRateLimitWindowMs: 60_000,
    });
    await app.ready();

    try {
      // Drive POST /v1/invites — the inviteUrl MUST NOT appear in logs.
      await app.inject({
        method: 'POST',
        url: '/v1/invites',
        headers: auth('valid-token'),
        payload: { email: 'new@example.com', role: 'member' },
      });

      // Drive POST /v1/auth/oidc/google/callback with an invite token in body.
      await app.inject({
        method: 'POST',
        url: '/v1/auth/oidc/google/callback',
        payload: {
          tenantSlug: 'acme',
          code: 'auth-code',
          state: 'state-value',
          inviteToken: rawInviteToken,
        },
      });
    } finally {
      await app.close();
    }

    const allLogs = lines.join('\n');

    // The raw inviteToken must NEVER appear in logs (R-INV-12).
    expect(allLogs).not.toContain(rawInviteToken);
    // The one-time inviteUrl must NEVER appear in logs (R-INV-12).
    expect(allLogs).not.toContain('should-not-appear');
    // Neither the string 'inviteToken' nor 'inviteUrl' should appear as a
    // key in any log object (defence-in-depth: ensures redaction by omission).
    expect(allLogs).not.toContain('"inviteToken"');
    expect(allLogs).not.toContain('"inviteUrl"');
    expect(allLogs).not.toContain('"token_hash"');
  });
});
