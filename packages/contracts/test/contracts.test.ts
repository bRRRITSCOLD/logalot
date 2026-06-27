import { describe, expect, it } from 'vitest';
import {
  createAlertRuleRequestSchema,
  createApiKeyRequestSchema,
  createTenantRequestSchema,
  createUserRequestSchema,
  loginRequestSchema,
  updateAlertRuleRequestSchema,
} from '../src/index.js';

describe('createTenantRequest', () => {
  it('accepts a valid slug + name', () => {
    const r = createTenantRequestSchema.parse({ publicId: 'acme-corp', name: 'Acme' });
    expect(r.publicId).toBe('acme-corp');
  });

  it.each([
    ['UPPER', { publicId: 'Acme', name: 'x' }],
    ['leading hyphen', { publicId: '-acme', name: 'x' }],
    ['too short', { publicId: 'ab', name: 'x' }],
    ['underscore (would break key parsing)', { publicId: 'ac_me', name: 'x' }],
    ['empty name', { publicId: 'acme', name: '' }],
  ])('rejects %s', (_label, input) => {
    expect(createTenantRequestSchema.safeParse(input).success).toBe(false);
  });

  it('rejects unknown keys (strict)', () => {
    expect(
      createTenantRequestSchema.safeParse({ publicId: 'acme', name: 'x', extra: 1 }).success,
    ).toBe(false);
  });
});

describe('createUserRequest', () => {
  it('defaults role to member', () => {
    const r = createUserRequestSchema.parse({ email: 'a@b.com', password: 'longenough' });
    expect(r.role).toBe('member');
  });

  it('rejects a short password', () => {
    expect(createUserRequestSchema.safeParse({ email: 'a@b.com', password: 'short' }).success).toBe(
      false,
    );
  });

  it('rejects a bad email', () => {
    expect(
      createUserRequestSchema.safeParse({ email: 'nope', password: 'longenough' }).success,
    ).toBe(false);
  });

  it('rejects an invalid role', () => {
    expect(
      createUserRequestSchema.safeParse({
        email: 'a@b.com',
        password: 'longenough',
        role: 'platform_operator',
      }).success,
    ).toBe(false);
  });
});

describe('createApiKeyRequest', () => {
  it('defaults scopes to ingest:write', () => {
    const r = createApiKeyRequestSchema.parse({ name: 'ci' });
    expect(r.scopes).toEqual(['ingest:write']);
  });

  it('rejects an unknown scope', () => {
    expect(createApiKeyRequestSchema.safeParse({ name: 'ci', scopes: ['admin:all'] }).success).toBe(
      false,
    );
  });
});

describe('createAlertRuleRequest', () => {
  it('applies sensible defaults', () => {
    const r = createAlertRuleRequestSchema.parse({ name: 'errors', threshold: 5 });
    expect(r.comparator).toBe('gt');
    expect(r.windowSeconds).toBe(300);
    expect(r.severity).toBe('warning');
    expect(r.enabled).toBe(true);
    expect(r.notifyChannels).toEqual([]);
  });

  it('accepts a webhook channel + inline query', () => {
    const r = createAlertRuleRequestSchema.parse({
      name: 'payment errors',
      threshold: 10,
      query: { text: 'payment failed', level: 'error' },
      notifyChannels: [{ type: 'webhook', url: 'https://hooks.example/x' }],
    });
    expect(r.query.level).toBe('error');
    expect(r.notifyChannels[0]).toMatchObject({ type: 'webhook' });
  });

  it.each([
    ['negative threshold', { name: 'x', threshold: -1 }],
    ['window below 30s', { name: 'x', threshold: 1, windowSeconds: 10 }],
    ['window above 1d', { name: 'x', threshold: 1, windowSeconds: 999999 }],
    ['unknown comparator', { name: 'x', threshold: 1, comparator: 'between' }],
    ['bad level', { name: 'x', threshold: 1, query: { level: 'verbose' } }],
    ['email channel without to', { name: 'x', threshold: 1, notifyChannels: [{ type: 'email' }] }],
    ['unknown key (strict)', { name: 'x', threshold: 1, extra: true }],
    ['empty name', { name: '', threshold: 1 }],
  ])('rejects %s', (_label, input) => {
    expect(createAlertRuleRequestSchema.safeParse(input).success).toBe(false);
  });

  it('does not allow setting state (evaluator-owned)', () => {
    expect(
      createAlertRuleRequestSchema.safeParse({ name: 'x', threshold: 1, state: 'firing' }).success,
    ).toBe(false);
  });
});

describe('updateAlertRuleRequest', () => {
  it('accepts a partial patch', () => {
    expect(updateAlertRuleRequestSchema.safeParse({ enabled: false }).success).toBe(true);
  });

  it('rejects an empty patch', () => {
    expect(updateAlertRuleRequestSchema.safeParse({}).success).toBe(false);
  });
});

describe('loginRequest', () => {
  it('requires tenantSlug, email, password', () => {
    expect(loginRequestSchema.safeParse({ email: 'a@b.com', password: 'x' }).success).toBe(false);
    expect(
      loginRequestSchema.safeParse({ tenantSlug: 'acme', email: 'a@b.com', password: 'x' }).success,
    ).toBe(true);
  });
});
