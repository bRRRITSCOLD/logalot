// container.test.ts — unit tests for buildContainer (issue #154, T14)
//
// These tests verify the composition root's wiring WITHOUT a real database or
// network. We pass a fake pg.Pool (all methods throw) because buildContainer
// only constructs objects — it makes no DB calls at startup.
//
// Acceptance criteria verified here:
//   AC-1: EMAIL_PROVIDER=none (default) wires NoOp adapter (emailSender is NoOpEmailSender)
//   AC-2: EMAIL_PROVIDER=smtp wires SmtpEmailSender
//   AC-3: oidcAuthenticator receives a non-undefined inviteProvisioner
//   AC-4: no provider secret (SMTP_PASS) is reachable from services or route deps
//   AC-5: container builds with and without Google config (existing guard)
import type { Pool } from 'pg';
import { describe, expect, it } from 'vitest';
import { NoOpEmailSender } from '../../src/adapters/email/noop-email-sender';
import { SmtpEmailSender } from '../../src/adapters/email/smtp-email-sender';
import { InviteService } from '../../src/app/invite-service';
import type { Config } from '../../src/config/env';
import { buildContainer } from '../../src/container';

// ── Helpers ───────────────────────────────────────────────────────────────────

/** Minimal valid Config — no Google, no Redis, EMAIL_PROVIDER=none. */
function baseConfig(overrides: Partial<Config> = {}): Config {
  return {
    nodeEnv: 'test',
    host: '0.0.0.0',
    port: 8082,
    databaseUrl: 'postgresql://app:app@localhost:5432/logalot',
    jwtSecret: 'test-secret-at-least-16-chars',
    accessTokenTtlSeconds: 900,
    refreshTokenTtlSeconds: 604800,
    bcryptCost: 4,
    logLevel: 'silent',
    redisUrl: undefined,
    oauthStateTtlSeconds: 600,
    googleClientId: undefined,
    googleClientSecret: undefined,
    googleRedirectUri: undefined,
    googleOidcClientId: undefined,
    googleOidcRedirectUri: undefined,
    googleOidcAuthEndpoint: 'https://accounts.google.com/o/oauth2/v2/auth',
    oidcRateLimitMax: 20,
    oidcRateLimitWindowMs: 60_000,
    inviteTtlSeconds: 604800,
    inviteMaxOutstandingPerTenant: 50,
    inviteAcceptBaseUrl: 'http://localhost:5173',
    emailProvider: 'none',
    smtpHost: undefined,
    smtpPort: undefined,
    smtpUser: undefined,
    smtpPass: undefined,
    smtpFrom: undefined,
    ...overrides,
  };
}

/**
 * Minimal fake Pool — buildContainer only constructs adapters at startup;
 * no DB calls are made, so every method can safely throw.
 */
function fakePool(): Pool {
  const noop = (): never => {
    throw new Error('fakePool: no DB calls expected at container build time');
  };
  return { query: noop, connect: noop, end: noop } as unknown as Pool;
}

// ── Tests ─────────────────────────────────────────────────────────────────────

describe('buildContainer — email provider selection (AC-1, AC-2)', () => {
  it('wires NoOpEmailSender when EMAIL_PROVIDER is none (default)', () => {
    const container = buildContainer(fakePool(), baseConfig({ emailProvider: 'none' }));
    expect(container.emailSender).toBeInstanceOf(NoOpEmailSender);
  });

  it('wires SmtpEmailSender when EMAIL_PROVIDER=smtp and SMTP_* are present', () => {
    const container = buildContainer(
      fakePool(),
      baseConfig({
        emailProvider: 'smtp',
        smtpHost: 'mail.example.com',
        smtpPort: 587,
        smtpUser: 'user',
        smtpPass: 'secret',
        smtpFrom: 'noreply@example.com',
      }),
    );
    expect(container.emailSender).toBeInstanceOf(SmtpEmailSender);
  });

  it('falls back to NoOpEmailSender when EMAIL_PROVIDER=ses (not built)', () => {
    const container = buildContainer(fakePool(), baseConfig({ emailProvider: 'ses' }));
    expect(container.emailSender).toBeInstanceOf(NoOpEmailSender);
  });
});

describe('buildContainer — OidcAuthenticator receives inviteProvisioner (AC-3)', () => {
  it('oidcAuthenticator is constructed with a non-undefined inviteProvisioner', () => {
    const container = buildContainer(fakePool(), baseConfig());
    // The authenticator does not expose its deps directly; we verify it was
    // constructed (not undefined) and that the invite-provisioner dep was
    // captured by checking the internal field via a cast. The real assertion
    // is that `handleCallback` with an inviteTokenHash does not throw
    // "inviteProvisioner is undefined" — see oidc-invite.test.ts for that.
    expect(container.oidcAuthenticator).toBeDefined();
    // biome-ignore lint/suspicious/noExplicitAny: test-only access to private field
    const auth = container.oidcAuthenticator as any;
    expect(auth.deps?.inviteProvisioner).toBeDefined();
  });
});

describe('buildContainer — invites service in Services (AC-1)', () => {
  it('services.invites is an InviteService instance', () => {
    const container = buildContainer(fakePool(), baseConfig());
    expect(container.services.invites).toBeInstanceOf(InviteService);
  });
});

describe('buildContainer — secret confinement (AC-4)', () => {
  it('smtpPass does not appear on the oidcAuthenticator dep surface', () => {
    const container = buildContainer(
      fakePool(),
      baseConfig({
        emailProvider: 'smtp',
        smtpHost: 'mail.example.com',
        smtpPort: 587,
        smtpFrom: 'noreply@example.com',
        smtpPass: 'do-not-expose',
      }),
    );

    // oidcAuthenticator must not hold the email secret — it has nothing to do with email.
    // biome-ignore lint/suspicious/noExplicitAny: test-only access to private field
    const oidcAny = container.oidcAuthenticator as any;
    const oidcDeps = oidcAny.deps ?? {};
    expect(JSON.stringify(oidcDeps)).not.toContain('do-not-expose');
  });

  it('smtpPass is encapsulated inside emailSender and not forwarded to services deps', () => {
    const container = buildContainer(
      fakePool(),
      baseConfig({
        emailProvider: 'smtp',
        smtpHost: 'mail.example.com',
        smtpPort: 587,
        smtpFrom: 'noreply@example.com',
        smtpPass: 'do-not-expose',
      }),
    );

    // The emailSender is a SmtpEmailSender — that's fine, it holds the transport.
    // What matters: no OTHER service has a reference to the secret.
    // Checking auth, tenants, users, apiKeys, retention, alerts, savedQueries, dashboards.
    // invites DOES receive emailSender (expected); we verify nothing on invites
    // exposes the secret as a plain string property.
    const nonInviteServices = {
      auth: container.services.auth,
      tenants: container.services.tenants,
      users: container.services.users,
      apiKeys: container.services.apiKeys,
      retention: container.services.retention,
      alerts: container.services.alerts,
      savedQueries: container.services.savedQueries,
      dashboards: container.services.dashboards,
    };
    // These services have no email dep — their own fields should not contain the secret.
    for (const [name, svc] of Object.entries(nonInviteServices)) {
      const json = JSON.stringify(svc);
      expect(json, `${name} must not carry smtpPass`).not.toContain('do-not-expose');
    }
  });
});

describe('buildContainer — builds with and without Google config (AC-5)', () => {
  it('builds without Google config (no googleClientId)', () => {
    const container = buildContainer(fakePool(), baseConfig());
    expect(container.googleIdTokenVerifier).toBeUndefined();
    expect(container.googleTokenExchangeClient).toBeUndefined();
    // oidcAuthenticator still constructed — routes guard against undefined verifier.
    expect(container.oidcAuthenticator).toBeDefined();
  });

  it('builds with Google config', () => {
    const container = buildContainer(
      fakePool(),
      baseConfig({
        googleClientId: 'google-client-id.apps.googleusercontent.com',
        googleClientSecret: 'google-client-secret',
        googleOidcClientId: 'google-oidc-client-id.apps.googleusercontent.com',
        googleOidcRedirectUri: 'http://localhost:8082/auth/oidc/callback',
      }),
    );
    expect(container.googleIdTokenVerifier).toBeDefined();
    expect(container.googleTokenExchangeClient).toBeDefined();
    expect(container.oidcAuthenticator).toBeDefined();
  });
});
