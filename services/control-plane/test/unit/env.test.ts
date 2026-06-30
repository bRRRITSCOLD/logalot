import { describe, expect, it } from 'vitest';
import { loadConfig } from '../../src/config/env';

/** Minimal valid env — all required fields, no optionals. */
const VALID_BASE: NodeJS.ProcessEnv = {
  LOGALOT_APP_DATABASE_URL: 'postgresql://app:app@localhost:5432/logalot',
  JWT_SECRET: 'supersecretvalue1234',
};

describe('loadConfig — invite defaults', () => {
  it('defaults INVITE_TTL_SECONDS to 7 days (604800 s)', () => {
    const cfg = loadConfig(VALID_BASE);
    expect(cfg.inviteTtlSeconds).toBe(60 * 60 * 24 * 7);
  });

  it('defaults INVITE_MAX_OUTSTANDING_PER_TENANT to 50', () => {
    const cfg = loadConfig(VALID_BASE);
    expect(cfg.inviteMaxOutstandingPerTenant).toBe(50);
  });

  it('defaults INVITE_ACCEPT_BASE_URL to localhost', () => {
    const cfg = loadConfig(VALID_BASE);
    expect(cfg.inviteAcceptBaseUrl).toBe('http://localhost:5173');
  });

  it('accepts a custom INVITE_TTL_SECONDS', () => {
    const cfg = loadConfig({ ...VALID_BASE, INVITE_TTL_SECONDS: '3600' });
    expect(cfg.inviteTtlSeconds).toBe(3600);
  });

  it('accepts a custom INVITE_MAX_OUTSTANDING_PER_TENANT', () => {
    const cfg = loadConfig({ ...VALID_BASE, INVITE_MAX_OUTSTANDING_PER_TENANT: '100' });
    expect(cfg.inviteMaxOutstandingPerTenant).toBe(100);
  });

  it('accepts a custom INVITE_ACCEPT_BASE_URL', () => {
    const cfg = loadConfig({ ...VALID_BASE, INVITE_ACCEPT_BASE_URL: 'https://app.logalot.io' });
    expect(cfg.inviteAcceptBaseUrl).toBe('https://app.logalot.io');
  });

  it('rejects a non-URL INVITE_ACCEPT_BASE_URL', () => {
    expect(() => loadConfig({ ...VALID_BASE, INVITE_ACCEPT_BASE_URL: 'not-a-url' })).toThrow();
  });

  it('rejects a non-positive INVITE_TTL_SECONDS', () => {
    expect(() => loadConfig({ ...VALID_BASE, INVITE_TTL_SECONDS: '0' })).toThrow();
    expect(() => loadConfig({ ...VALID_BASE, INVITE_TTL_SECONDS: '-1' })).toThrow();
  });
});

describe('loadConfig — EMAIL_PROVIDER defaults', () => {
  it("defaults EMAIL_PROVIDER to 'none'", () => {
    const cfg = loadConfig(VALID_BASE);
    expect(cfg.emailProvider).toBe('none');
  });

  it("parses EMAIL_PROVIDER='none' without requiring SMTP params", () => {
    const cfg = loadConfig({ ...VALID_BASE, EMAIL_PROVIDER: 'none' });
    expect(cfg.emailProvider).toBe('none');
    expect(cfg.smtpHost).toBeUndefined();
  });

  it("parses EMAIL_PROVIDER='ses' without requiring SMTP params", () => {
    const cfg = loadConfig({ ...VALID_BASE, EMAIL_PROVIDER: 'ses' });
    expect(cfg.emailProvider).toBe('ses');
  });

  it('rejects an invalid EMAIL_PROVIDER value', () => {
    expect(() => loadConfig({ ...VALID_BASE, EMAIL_PROVIDER: 'sendgrid' })).toThrow();
    expect(() => loadConfig({ ...VALID_BASE, EMAIL_PROVIDER: '' })).toThrow();
  });
});

describe("loadConfig — EMAIL_PROVIDER='smtp' validation", () => {
  const SMTP_VALID: NodeJS.ProcessEnv = {
    ...VALID_BASE,
    EMAIL_PROVIDER: 'smtp',
    SMTP_HOST: 'mail.example.com',
    SMTP_PORT: '587',
    SMTP_FROM: 'no-reply@example.com',
  };

  it('parses successfully when all required SMTP params are provided', () => {
    const cfg = loadConfig(SMTP_VALID);
    expect(cfg.emailProvider).toBe('smtp');
    expect(cfg.smtpHost).toBe('mail.example.com');
    expect(cfg.smtpPort).toBe(587);
    expect(cfg.smtpFrom).toBe('no-reply@example.com');
  });

  it('includes optional SMTP_USER and SMTP_PASS when provided', () => {
    const cfg = loadConfig({ ...SMTP_VALID, SMTP_USER: 'user', SMTP_PASS: 'secret' });
    expect(cfg.smtpUser).toBe('user');
    expect(cfg.smtpPass).toBe('secret');
  });

  it('is a startup error when SMTP_HOST is missing', () => {
    const { SMTP_HOST: _h, ...rest } = SMTP_VALID;
    expect(() => loadConfig(rest)).toThrow(/SMTP_HOST/);
  });

  it('is a startup error when SMTP_PORT is missing', () => {
    const { SMTP_PORT: _p, ...rest } = SMTP_VALID;
    expect(() => loadConfig(rest)).toThrow(/SMTP_PORT/);
  });

  it('is a startup error when SMTP_FROM is missing', () => {
    const { SMTP_FROM: _f, ...rest } = SMTP_VALID;
    expect(() => loadConfig(rest)).toThrow(/SMTP_FROM/);
  });

  it('SMTP_USER is optional even when provider=smtp', () => {
    const cfg = loadConfig(SMTP_VALID); // no SMTP_USER
    expect(cfg.smtpUser).toBeUndefined();
  });

  it('SMTP_PASS is optional even when provider=smtp (some relays skip auth)', () => {
    const cfg = loadConfig(SMTP_VALID); // no SMTP_PASS
    expect(cfg.smtpPass).toBeUndefined();
  });

  it('rejects an invalid (non-positive) SMTP_PORT', () => {
    expect(() => loadConfig({ ...SMTP_VALID, SMTP_PORT: '0' })).toThrow();
    expect(() => loadConfig({ ...SMTP_VALID, SMTP_PORT: '-25' })).toThrow();
  });
});
