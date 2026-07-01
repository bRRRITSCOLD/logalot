import { randomUUID } from 'node:crypto';
import type { FastifyInstance } from 'fastify';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { buildServer, LOG_REDACT_PATHS } from '../../src/adapters/http/server';
import type { OidcAuthenticator } from '../../src/app/oidc-authenticator';
import type { TokenService } from '../../src/app/ports';
import type { Services } from '../../src/container';

// ── Never-log denylist (issue #158, R-INV-12) ─────────────────────────────────
//
// The invite accept-path fix has two halves: the Caddy access log (redacts the
// `token` query param — see infra/aws/Caddyfile + the log-capture integration
// test at infra/aws/caddyfile-log-hygiene.integration.sh) and the control-plane
// application logger's redact denylist, exercised here.
//
// This suite drives buildServer's DEFAULT logger config (no `opts.logger`
// override) end-to-end through real pino/Fastify — it captures process.stdout
// (pino's default destination when no stream is given) so the assertions cover
// the exact configuration that runs in production, not a re-implementation of it.

function makeStubTokenService(): TokenService {
  return {
    issueAccess: vi.fn(),
    verifyAccess: vi.fn().mockResolvedValue({
      tenantId: randomUUID(),
      principalId: randomUUID(),
      role: 'tenant_admin',
    }),
  };
}

function makeStubOidcAuthenticator(): OidcAuthenticator {
  return {
    beginAuthorize: vi.fn(),
    handleCallback: vi.fn(),
  } as unknown as OidcAuthenticator;
}

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

describe('LOG_REDACT_PATHS (issue #158, R-INV-12)', () => {
  it('lists the plaintext invite token and token_hash on the never-log denylist', () => {
    expect(LOG_REDACT_PATHS).toContain('req.body.token');
    expect(LOG_REDACT_PATHS).toContain('req.body.inviteToken');
    expect(LOG_REDACT_PATHS).toContain('req.query.token');
    expect(LOG_REDACT_PATHS).toContain('res.body.token_hash');
    expect(LOG_REDACT_PATHS).toContain('token_hash');
    expect(LOG_REDACT_PATHS).toContain('inviteToken');
    expect(LOG_REDACT_PATHS).toContain('inviteUrl');
    expect(LOG_REDACT_PATHS).toContain('*.token_hash');
    expect(LOG_REDACT_PATHS).toContain('*.inviteToken');
    expect(LOG_REDACT_PATHS).toContain('*.inviteUrl');
  });
});

describe('buildServer default logger: redaction (issue #158, R-INV-12)', () => {
  let app: FastifyInstance | undefined;
  let originalWrite: typeof process.stdout.write;

  afterEach(async () => {
    if (app) {
      await app.close();
      app = undefined;
    }
    if (originalWrite) {
      process.stdout.write = originalWrite;
    }
  });

  it('strips token_hash / inviteToken / inviteUrl from an object logged via the default logger', async () => {
    const lines: string[] = [];
    originalWrite = process.stdout.write.bind(process.stdout);
    // buildServer's DEFAULT logger writes to stdout (no stream override) —
    // capture it so we exercise the exact production config end-to-end.
    process.stdout.write = ((chunk: string | Uint8Array) => {
      lines.push(chunk.toString());
      return true;
    }) as typeof process.stdout.write;

    app = buildServer({
      services: makeStubServices(),
      tokenService: makeStubTokenService(),
      oidcAuthenticator: makeStubOidcAuthenticator(),
      ping: async () => true,
      trustProxy: false,
      // No `logger` override — exercises buildServer's default redact config.
    });
    await app.ready();

    const rawTokenHash = 'deadbeefdeadbeefdeadbeefdeadbeefdeadbeefdeadbeefdeadbeefdeadbeef';
    const rawInviteToken = `acme.${'c'.repeat(64)}`;
    const rawInviteUrl = `https://app.example.com/invite/accept?token=${rawInviteToken}`;

    app.log.info(
      { token_hash: rawTokenHash, inviteToken: rawInviteToken, inviteUrl: rawInviteUrl },
      'test: sensitive invite fields',
    );

    const allLogs = lines.join('\n');
    expect(allLogs).not.toContain(rawTokenHash);
    expect(allLogs).not.toContain(rawInviteToken);
    expect(allLogs).not.toContain(rawInviteUrl);
    expect(allLogs).toContain('test: sensitive invite fields');
  });
});
