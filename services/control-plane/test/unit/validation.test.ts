import {
  createApiKeyRequestSchema,
  createTenantRequestSchema,
  createUserRequestSchema,
  loginRequestSchema,
} from '@logalot/contracts';
import { describe, expect, it } from 'vitest';
import { parse } from '../../src/adapters/http/validation';
import { ValidationError } from '../../src/domain/errors';

describe('boundary validation (shared @logalot/contracts schemas)', () => {
  it('accepts a well-formed login and rejects a bad tenant slug', () => {
    expect(
      parse(loginRequestSchema, { tenantSlug: 'acme', email: 'a@b.co', password: 'x' }),
    ).toEqual({ tenantSlug: 'acme', email: 'a@b.co', password: 'x' });
    // Uppercase violates the slug regex (migration 000003).
    expect(() =>
      parse(loginRequestSchema, { tenantSlug: 'Acme', email: 'a@b.co', password: 'x' }),
    ).toThrow(ValidationError);
  });

  it('enforces the password floor on user creation', () => {
    expect(() =>
      parse(createUserRequestSchema, { email: 'a@b.co', password: 'short', role: 'member' }),
    ).toThrow(ValidationError);
  });

  it('rejects an unknown api-key scope (closed enum); default applied when absent', () => {
    // Default remains ingest:write (common case).
    expect(parse(createApiKeyRequestSchema, { name: 'ci' }).scopes).toEqual(['ingest:write']);
    // logs:read is now a valid scope (#82).
    expect(
      parse(createApiKeyRequestSchema, { name: 'reader', scopes: ['logs:read'] }).scopes,
    ).toEqual(['logs:read']);
    // Arbitrary scopes not in the enum are still rejected.
    expect(() => parse(createApiKeyRequestSchema, { name: 'ci', scopes: ['admin:all'] })).toThrow(
      ValidationError,
    );
  });

  it('rejects a tenant body that smuggles extra fields (.strict) — no body-asserted tenant', () => {
    // The contract schema is strict, so a body-asserted tenant id is REJECTED,
    // not silently ignored — tenancy can only come from the verified session.
    expect(() =>
      parse(createTenantRequestSchema, {
        publicId: 'acme',
        name: 'Acme',
        tenantId: 'attacker-controlled',
      }),
    ).toThrow(ValidationError);
    expect(parse(createTenantRequestSchema, { publicId: 'acme', name: 'Acme' })).toEqual({
      publicId: 'acme',
      name: 'Acme',
    });
  });
});
