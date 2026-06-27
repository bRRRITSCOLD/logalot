import { describe, expect, it } from 'vitest';
import {
  createApiKeyRequestSchema,
  createTenantRequestSchema,
  createUserRequestSchema,
  loginRequestSchema,
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

describe('loginRequest', () => {
  it('requires tenantSlug, email, password', () => {
    expect(loginRequestSchema.safeParse({ email: 'a@b.com', password: 'x' }).success).toBe(false);
    expect(
      loginRequestSchema.safeParse({ tenantSlug: 'acme', email: 'a@b.com', password: 'x' }).success,
    ).toBe(true);
  });
});
