import { describe, expect, it } from 'vitest';
import {
  createInviteRequestSchema,
  inviteCreatedResponseSchema,
  inviteListSchema,
  inviteResponseSchema,
  parseInviteTenantSlug,
} from './invite.js';

const validInviteResponse = {
  id: '00000000-0000-0000-0000-000000000001',
  tenantId: '00000000-0000-0000-0000-000000000002',
  email: 'alice@example.com',
  role: 'member' as const,
  status: 'pending' as const,
  expiresAt: '2026-07-30T00:00:00.000Z',
  createdBy: '00000000-0000-0000-0000-000000000003',
  consumedAt: null,
  createdAt: '2026-06-30T00:00:00.000Z',
  updatedAt: '2026-06-30T00:00:00.000Z',
};

describe('createInviteRequestSchema', () => {
  it('accepts a valid create request with default role', () => {
    const result = createInviteRequestSchema.safeParse({
      email: 'alice@example.com',
    });
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.role).toBe('member');
    }
  });

  it('role defaults to member when omitted', () => {
    const result = createInviteRequestSchema.safeParse({
      email: 'bob@example.com',
    });
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.role).toBe('member');
    }
  });

  it('accepts role: admin explicitly', () => {
    const result = createInviteRequestSchema.safeParse({
      email: 'carol@example.com',
      role: 'admin',
    });
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.role).toBe('admin');
    }
  });

  it('accepts role: member explicitly', () => {
    const result = createInviteRequestSchema.safeParse({
      email: 'dave@example.com',
      role: 'member',
    });
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.role).toBe('member');
    }
  });

  it('rejects an unknown role (R-INV-8)', () => {
    const result = createInviteRequestSchema.safeParse({
      email: 'eve@example.com',
      role: 'superuser',
    });
    expect(result.success).toBe(false);
  });

  it('rejects a body carrying a token field (R-INV-8 — .strict())', () => {
    const result = createInviteRequestSchema.safeParse({
      email: 'frank@example.com',
      token: 'some-secret-token',
    });
    expect(result.success).toBe(false);
  });

  it('rejects a body carrying a tokenHash field (R-INV-8 — .strict())', () => {
    const result = createInviteRequestSchema.safeParse({
      email: 'grace@example.com',
      tokenHash: 'abc123',
    });
    expect(result.success).toBe(false);
  });

  it('rejects a body carrying any extra key (R-INV-8 — .strict())', () => {
    const result = createInviteRequestSchema.safeParse({
      email: 'henry@example.com',
      extraField: 'not-allowed',
    });
    expect(result.success).toBe(false);
  });

  it('rejects an invalid email address', () => {
    const result = createInviteRequestSchema.safeParse({
      email: 'not-an-email',
    });
    expect(result.success).toBe(false);
  });

  it('rejects an email exceeding 320 characters', () => {
    const longEmail = `${'a'.repeat(310)}@example.com`;
    const result = createInviteRequestSchema.safeParse({ email: longEmail });
    expect(result.success).toBe(false);
  });

  it('rejects missing email', () => {
    const result = createInviteRequestSchema.safeParse({ role: 'member' });
    expect(result.success).toBe(false);
  });
});

describe('inviteResponseSchema', () => {
  it('accepts a valid invite response', () => {
    const result = inviteResponseSchema.safeParse(validInviteResponse);
    expect(result.success).toBe(true);
  });

  it('accepts a consumed invite with consumedAt set', () => {
    const result = inviteResponseSchema.safeParse({
      ...validInviteResponse,
      status: 'consumed',
      consumedAt: '2026-07-01T00:00:00.000Z',
    });
    expect(result.success).toBe(true);
  });

  it('accepts a revoked invite', () => {
    const result = inviteResponseSchema.safeParse({
      ...validInviteResponse,
      status: 'revoked',
    });
    expect(result.success).toBe(true);
  });

  it('accepts createdBy: null (system-generated invite)', () => {
    const result = inviteResponseSchema.safeParse({
      ...validInviteResponse,
      createdBy: null,
    });
    expect(result.success).toBe(true);
  });

  it('does not have a token field in the schema', () => {
    // The response schema must not accept or expose a token/secret field.
    // Parsing a payload that includes token should still succeed (non-strict)
    // but the output must not contain the token.
    const result = inviteResponseSchema.safeParse({
      ...validInviteResponse,
      token: 'should-be-stripped',
    });
    // non-strict parse strips unknown keys
    expect(result.success).toBe(true);
    if (result.success) {
      expect((result.data as Record<string, unknown>).token).toBeUndefined();
    }
  });

  it('rejects an invalid status value', () => {
    const result = inviteResponseSchema.safeParse({
      ...validInviteResponse,
      status: 'expired',
    });
    expect(result.success).toBe(false);
  });
});

describe('inviteCreatedResponseSchema', () => {
  it('requires inviteUrl', () => {
    // Must fail when inviteUrl is missing.
    const result = inviteCreatedResponseSchema.safeParse(validInviteResponse);
    expect(result.success).toBe(false);
  });

  it('accepts a valid issued-invite response with inviteUrl', () => {
    const result = inviteCreatedResponseSchema.safeParse({
      ...validInviteResponse,
      inviteUrl: 'https://app.example.com/accept-invite?token=abc123',
    });
    expect(result.success).toBe(true);
  });

  it('rejects a non-URL inviteUrl', () => {
    const result = inviteCreatedResponseSchema.safeParse({
      ...validInviteResponse,
      inviteUrl: 'not-a-url',
    });
    expect(result.success).toBe(false);
  });
});

describe('inviteListSchema', () => {
  it('accepts an empty invite list', () => {
    const result = inviteListSchema.safeParse({ invites: [] });
    expect(result.success).toBe(true);
  });

  it('accepts a list with valid invite entries', () => {
    const result = inviteListSchema.safeParse({
      invites: [validInviteResponse, { ...validInviteResponse, status: 'consumed' }],
    });
    expect(result.success).toBe(true);
  });

  it('rejects an invalid invite entry inside the list', () => {
    const result = inviteListSchema.safeParse({
      invites: [{ ...validInviteResponse, status: 'invalid-status' }],
    });
    expect(result.success).toBe(false);
  });
});

describe('parseInviteTenantSlug', () => {
  it('extracts the tenant public id from a well-formed token', () => {
    expect(parseInviteTenantSlug('lginv_acme-corp_deadbeefcafebabe')).toBe('acme-corp');
  });

  it('returns null for a token missing the lginv_ prefix', () => {
    expect(parseInviteTenantSlug('acme-corp_deadbeef')).toBeNull();
  });

  it('returns null for a token with no secret segment', () => {
    expect(parseInviteTenantSlug('lginv_acme-corp')).toBeNull();
  });

  it('returns null for a token with an empty publicId', () => {
    expect(parseInviteTenantSlug('lginv__deadbeef')).toBeNull();
  });

  it('returns null for a token with an empty secret', () => {
    expect(parseInviteTenantSlug('lginv_acme-corp_')).toBeNull();
  });

  it('returns null when the extracted publicId fails tenantPublicIdSchema', () => {
    // '!' is not a valid tenant public id character.
    expect(parseInviteTenantSlug('lginv_bad!slug_deadbeef')).toBeNull();
  });

  it('preserves underscores inside the secret (does not truncate at the first "_")', () => {
    expect(parseInviteTenantSlug('lginv_acme-corp_dead_beef_cafe')).toBe('acme-corp');
  });

  it('returns null for a completely empty string', () => {
    expect(parseInviteTenantSlug('')).toBeNull();
  });

  it('returns null when tenantSlug component fails the length bound (single char)', () => {
    expect(parseInviteTenantSlug('lginv_a_deadbeef')).toBeNull();
  });
});
