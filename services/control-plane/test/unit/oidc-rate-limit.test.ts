import { randomUUID } from 'node:crypto';
import type { FastifyInstance } from 'fastify';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { buildServer } from '../../src/adapters/http/server';
import type { OidcAuthenticator } from '../../src/app/oidc-authenticator';
import type { TokenService } from '../../src/app/ports';
import type { Services } from '../../src/container';

// ── Minimal stubs ─────────────────────────────────────────────────────────────
//
// These stubs satisfy the type without a real database — all we're testing is
// the HTTP-layer rate-limit behaviour (429 after threshold), not business logic.

function makeStubServices(): Services {
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
    invites: {} as unknown as Services['invites'],
  };
}

function makeStubTokenService(): TokenService {
  return {
    issueAccess: vi.fn(),
    verifyAccess: vi.fn().mockRejectedValue(new Error('no token')),
  };
}

function makeStubOidcAuthenticator(): OidcAuthenticator {
  return {
    beginAuthorize: vi.fn().mockResolvedValue({ redirectUrl: 'https://example.com/auth' }),
    handleCallback: vi.fn().mockResolvedValue({
      tokens: {
        accessToken: 'access',
        refreshToken: 'refresh',
        expiresIn: 900,
        tokenType: 'Bearer',
        role: 'member',
        tenantId: randomUUID(),
        userId: randomUUID(),
      },
      returnTo: '/',
    }),
  } as unknown as OidcAuthenticator;
}

// buildTestServer creates a Fastify instance wired with stub deps and a
// configurable rate-limit ceiling (default 2 so tests stay fast).
async function buildTestServer(
  oidcRateLimitMax = 2,
): Promise<{ app: FastifyInstance; oidcAuthenticator: OidcAuthenticator }> {
  const oidcAuthenticator = makeStubOidcAuthenticator();
  const app = buildServer({
    services: makeStubServices(),
    tokenService: makeStubTokenService(),
    oidcAuthenticator,
    ping: async () => true,
    logger: false,
    // trustProxy is disabled in unit tests that inject directly (no real proxy
    // header).  The distinct-IP isolation test overrides this via a separate
    // server built with trustProxy: 1.
    trustProxy: false,
    oidcRateLimitMax,
    oidcRateLimitWindowMs: 60_000,
  });
  await app.ready();
  return { app, oidcAuthenticator };
}

// makeCaptureStream returns a pino-compatible destination stream that
// accumulates every JSON log line.  Pass it as `logger: { level, stream }` to
// buildServer so the in-process pino instance writes to it.  Each entry is
// a newline-terminated JSON string; we join and search the raw text to keep
// the assertion logic independent of the pino schema version.
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

// ── Tests ─────────────────────────────────────────────────────────────────────

describe('OIDC route rate limiting', () => {
  let app: FastifyInstance;

  beforeAll(async () => {
    ({ app } = await buildTestServer(2));
  });

  afterAll(async () => {
    await app.close();
  });

  describe('POST /v1/auth/oidc/google/callback', () => {
    const validCallbackPayload = { tenantSlug: 'acme', code: 'auth-code', state: 'some-state' };

    it('returns non-429 for the first request (within limit)', async () => {
      const res = await app.inject({
        method: 'POST',
        url: '/v1/auth/oidc/google/callback',
        payload: validCallbackPayload,
      });
      // 200 or 401 (stub returns resolved but state store has no real state)
      // The important thing: NOT 429.
      expect(res.statusCode).not.toBe(429);
    });

    it('returns non-429 for the second request (at limit)', async () => {
      const res = await app.inject({
        method: 'POST',
        url: '/v1/auth/oidc/google/callback',
        payload: validCallbackPayload,
      });
      expect(res.statusCode).not.toBe(429);
    });

    it('returns 429 after exceeding the per-IP threshold', async () => {
      // The first two requests (sent above in beforeAll + previous tests) have
      // consumed the max=2 budget.  This third request should be rate-limited.
      const res = await app.inject({
        method: 'POST',
        url: '/v1/auth/oidc/google/callback',
        payload: validCallbackPayload,
      });
      expect(res.statusCode).toBe(429);
    });

    it('rate-limit response body includes structured error fields', async () => {
      const res = await app.inject({
        method: 'POST',
        url: '/v1/auth/oidc/google/callback',
        payload: validCallbackPayload,
      });
      expect(res.statusCode).toBe(429);
      const body = res.json<{ error: string; message: string }>();
      expect(body.error).toBe('rate_limit_exceeded');
      expect(body.message).toMatch(/rate limit exceeded/i);
    });
  });

  describe('POST /v1/auth/oidc/google/authorize', () => {
    it('returns 429 after exceeding the per-IP threshold', async () => {
      // Build a fresh server to get a clean rate-limit counter.
      const { app: freshApp } = await buildTestServer(1);

      try {
        // First request consumes the max=1 budget.
        await freshApp.inject({
          method: 'POST',
          url: '/v1/auth/oidc/google/authorize',
          payload: { tenantSlug: 'acme' },
        });

        // Second request should be rate-limited.
        const res = await freshApp.inject({
          method: 'POST',
          url: '/v1/auth/oidc/google/authorize',
          payload: { tenantSlug: 'acme' },
        });
        expect(res.statusCode).toBe(429);
      } finally {
        await freshApp.close();
      }
    });
  });

  describe('per-IP isolation (trustProxy)', () => {
    // This test verifies that the rate-limit keyGenerator correctly isolates
    // counters per client IP when X-Forwarded-For is trusted (trustProxy: 1).
    // Without trustProxy, all clients share the proxy's socket address as the
    // key — one abusive caller would exhaust the budget for everyone.
    it('two distinct X-Forwarded-For IPs get independent rate-limit counters', async () => {
      const oidcAuthenticator = makeStubOidcAuthenticator();
      // Build a server with trustProxy: 1 so req.ip reads from XFF.
      const proxyApp = buildServer({
        services: makeStubServices(),
        tokenService: makeStubTokenService(),
        oidcAuthenticator,
        ping: async () => true,
        logger: false,
        trustProxy: 1,
        oidcRateLimitMax: 1,
        oidcRateLimitWindowMs: 60_000,
      });
      await proxyApp.ready();

      try {
        // IP-A exhausts its budget (max=1).
        await proxyApp.inject({
          method: 'POST',
          url: '/v1/auth/oidc/google/authorize',
          payload: { tenantSlug: 'acme' },
          headers: { 'x-forwarded-for': '10.0.0.1' },
        });

        // IP-A's second request must be rate-limited.
        const resA = await proxyApp.inject({
          method: 'POST',
          url: '/v1/auth/oidc/google/authorize',
          payload: { tenantSlug: 'acme' },
          headers: { 'x-forwarded-for': '10.0.0.1' },
        });
        expect(resA.statusCode).toBe(429);

        // IP-B's first request must NOT be rate-limited (independent counter).
        const resB = await proxyApp.inject({
          method: 'POST',
          url: '/v1/auth/oidc/google/authorize',
          payload: { tenantSlug: 'acme' },
          headers: { 'x-forwarded-for': '10.0.0.2' },
        });
        expect(resB.statusCode).not.toBe(429);
      } finally {
        await proxyApp.close();
      }
    });
  });
});

describe('OIDC route: no PII in logs', () => {
  // This test drives the authorize and callback routes against a server that
  // writes structured logs to an in-memory stream (not logger:false) so we can
  // inspect every JSON log line emitted during a full login flow and assert that
  // no raw secret or unmasked PII appears.
  //
  // The pino redact path-list in buildServer is a defence-in-depth layer for
  // body fields accidentally passed to req.log.  This test validates the
  // primary layer: the route handlers themselves must never pass raw
  // code/state/id_token/email to req.log.*.
  //
  // Technique: Fastify accepts `logger: { level, stream }` where `stream` is any
  // object with `write(msg: string)`.  Pino calls stream.write() once per log
  // entry with a newline-terminated JSON line, giving us real log capture without
  // Docker or a pino transport.
  it('authorize + callback do not log raw code, state, id_token, client_secret, or sub', async () => {
    const { stream, lines } = makeCaptureStream();

    const rawCode = 'super-secret-auth-code';
    const rawState = 'anti-csrf-state-token';

    // A stable userId value so we can assert it does not appear raw in logs.
    const stubUserId = '0123456789abcdef0123456789abcdef';
    const oidcAuthenticator: OidcAuthenticator = {
      beginAuthorize: vi
        .fn()
        .mockResolvedValue({ redirectUrl: 'https://accounts.google.com/auth' }),
      handleCallback: vi.fn().mockResolvedValue({
        tokens: {
          accessToken: 'access',
          refreshToken: 'refresh',
          expiresIn: 900,
          tokenType: 'Bearer',
          role: 'member',
          tenantId: 'tenant-uuid',
          userId: stubUserId,
        },
        returnTo: '/',
      }),
    } as unknown as OidcAuthenticator;

    const app = buildServer({
      services: makeStubServices(),
      tokenService: makeStubTokenService(),
      oidcAuthenticator,
      ping: async () => true,
      // Pass a pino-compatible stream so all log entries are captured.
      logger: { level: 'info', stream },
      trustProxy: false,
      oidcRateLimitMax: 100,
      oidcRateLimitWindowMs: 60_000,
    });
    await app.ready();

    try {
      // Drive POST /authorize
      await app.inject({
        method: 'POST',
        url: '/v1/auth/oidc/google/authorize',
        payload: { tenantSlug: 'acme' },
      });

      // Drive POST /callback with raw secrets in the body
      await app.inject({
        method: 'POST',
        url: '/v1/auth/oidc/google/callback',
        payload: { tenantSlug: 'acme', code: rawCode, state: rawState },
      });
    } finally {
      await app.close();
    }

    const allLogs = lines.join('\n');

    // Raw secrets and PII must NOT appear in any log line.
    expect(allLogs).not.toContain(rawCode);
    expect(allLogs).not.toContain(rawState);
    expect(allLogs).not.toContain(stubUserId);
    expect(allLogs).not.toContain('id_token');
    expect(allLogs).not.toContain('client_secret');

    // The logs MUST contain hashed identifiers (8-char hex strings) for
    // correlation — confirming that piiHash() was actually called by the routes.
    const hasStHash = lines.some((line) => /"stateHash":"[0-9a-f]{8}"/.test(line));
    const hasSubHash = lines.some((line) => /"subHash":"[0-9a-f]{8}"/.test(line));
    expect(hasStHash).toBe(true);
    expect(hasSubHash).toBe(true);
  });
});
