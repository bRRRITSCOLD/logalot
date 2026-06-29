import { describe, expect, it } from 'vitest';
import {
  oidcAuthorizeRequestSchema,
  oidcAuthorizeResponseSchema,
  oidcCallbackRequestSchema,
} from './oauth.js';

describe('oidcAuthorizeRequestSchema', () => {
  it('accepts a minimal valid request (no returnTo)', () => {
    const result = oidcAuthorizeRequestSchema.safeParse({ tenantSlug: 'acme-corp' });
    expect(result.success).toBe(true);
  });

  it('accepts a valid request with a relative returnTo', () => {
    const result = oidcAuthorizeRequestSchema.safeParse({
      tenantSlug: 'acme-corp',
      returnTo: '/dashboard',
    });
    expect(result.success).toBe(true);
  });

  it('accepts returnTo with a nested relative path', () => {
    const result = oidcAuthorizeRequestSchema.safeParse({
      tenantSlug: 'acme-corp',
      returnTo: '/tenant/acme-corp/logs?page=2',
    });
    expect(result.success).toBe(true);
  });

  it('rejects an absolute http:// returnTo', () => {
    const result = oidcAuthorizeRequestSchema.safeParse({
      tenantSlug: 'acme-corp',
      returnTo: 'http://evil.example/steal',
    });
    expect(result.success).toBe(false);
  });

  it('rejects an absolute https:// returnTo', () => {
    const result = oidcAuthorizeRequestSchema.safeParse({
      tenantSlug: 'acme-corp',
      returnTo: 'https://evil.example',
    });
    expect(result.success).toBe(false);
  });

  it('rejects a protocol-relative // returnTo', () => {
    const result = oidcAuthorizeRequestSchema.safeParse({
      tenantSlug: 'acme-corp',
      returnTo: '//evil.example',
    });
    expect(result.success).toBe(false);
  });

  it('rejects a Windows-style \\\\ returnTo', () => {
    const result = oidcAuthorizeRequestSchema.safeParse({
      tenantSlug: 'acme-corp',
      returnTo: '\\\\evil',
    });
    expect(result.success).toBe(false);
  });

  it('rejects a single \\ returnTo', () => {
    const result = oidcAuthorizeRequestSchema.safeParse({
      tenantSlug: 'acme-corp',
      returnTo: '\\evil',
    });
    expect(result.success).toBe(false);
  });

  it('rejects /\\ returnTo (backslash bypass — browsers normalize to //)', () => {
    const result = oidcAuthorizeRequestSchema.safeParse({
      tenantSlug: 'acme-corp',
      returnTo: '/\\evil.example',
    });
    expect(result.success).toBe(false);
  });

  it('rejects returnTo with leading whitespace before https:// (whitespace bypass)', () => {
    const result = oidcAuthorizeRequestSchema.safeParse({
      tenantSlug: 'acme-corp',
      returnTo: ' https://evil.example',
    });
    expect(result.success).toBe(false);
  });

  it('rejects returnTo with leading tab before javascript: (control-char bypass)', () => {
    const result = oidcAuthorizeRequestSchema.safeParse({
      tenantSlug: 'acme-corp',
      returnTo: '\tjavascript:alert(1)',
    });
    expect(result.success).toBe(false);
  });

  it('rejects a bare-relative returnTo without leading slash', () => {
    const result = oidcAuthorizeRequestSchema.safeParse({
      tenantSlug: 'acme-corp',
      returnTo: 'evil.example/path',
    });
    expect(result.success).toBe(false);
  });

  it('rejects returnTo with embedded TAB (WHATWG strips TAB → //evil.example open redirect)', () => {
    // Browsers strip U+0009 TAB while parsing, so "/\t/evil.example" → "//evil.example"
    const result = oidcAuthorizeRequestSchema.safeParse({
      tenantSlug: 'acme-corp',
      returnTo: '/\t/evil.example',
    });
    expect(result.success).toBe(false);
  });

  it('rejects returnTo with embedded LF (WHATWG strips LF → //evil open redirect)', () => {
    // Browsers strip U+000A LF while parsing, so "/\n//evil" → "//evil"
    const result = oidcAuthorizeRequestSchema.safeParse({
      tenantSlug: 'acme-corp',
      returnTo: '/\n//evil',
    });
    expect(result.success).toBe(false);
  });

  it('rejects returnTo with embedded CR (WHATWG strips CR → //evil open redirect)', () => {
    // Browsers strip U+000D CR while parsing, so "/\r/evil" → "//evil"
    const result = oidcAuthorizeRequestSchema.safeParse({
      tenantSlug: 'acme-corp',
      returnTo: '/\r/evil',
    });
    expect(result.success).toBe(false);
  });

  it('trims leading/trailing whitespace before validating returnTo', () => {
    // A value like "  /dashboard  " should be trimmed and accepted as "/dashboard"
    const result = oidcAuthorizeRequestSchema.safeParse({
      tenantSlug: 'acme-corp',
      returnTo: '  /dashboard  ',
    });
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.returnTo).toBe('/dashboard');
    }
  });

  it('rejects an invalid tenantSlug', () => {
    const result = oidcAuthorizeRequestSchema.safeParse({ tenantSlug: 'UPPER-CASE' });
    expect(result.success).toBe(false);
  });

  it('rejects extra unknown fields (strict)', () => {
    const result = oidcAuthorizeRequestSchema.safeParse({
      tenantSlug: 'acme-corp',
      unknown: 'field',
    });
    expect(result.success).toBe(false);
  });

  it('reuses tenantPublicIdSchema constraints (min length)', () => {
    // tenantPublicIdSchema requires 3-40 chars, no leading/trailing hyphen
    const result = oidcAuthorizeRequestSchema.safeParse({ tenantSlug: 'ab' });
    expect(result.success).toBe(false);
  });
});

describe('oidcAuthorizeResponseSchema', () => {
  it('accepts a valid IdP redirect URL', () => {
    const result = oidcAuthorizeResponseSchema.safeParse({
      redirectUrl: 'https://accounts.google.com/o/oauth2/v2/auth?client_id=abc&state=xyz',
    });
    expect(result.success).toBe(true);
  });

  it('rejects a non-URL redirectUrl', () => {
    const result = oidcAuthorizeResponseSchema.safeParse({ redirectUrl: 'not-a-url' });
    expect(result.success).toBe(false);
  });
  it('rejects a redirectUrl that does not target accounts.google.com (defense-in-depth open-redirect guard)', () => {
    // Even a syntactically valid URL must be rejected if it points at a non-Google host.
    const result = oidcAuthorizeResponseSchema.safeParse({
      redirectUrl: 'https://evil.example.com/authorize?client_id=abc&state=xyz',
    });
    expect(result.success).toBe(false);
  });

  it('rejects extra fields (strict)', () => {
    const result = oidcAuthorizeResponseSchema.safeParse({
      redirectUrl: 'https://accounts.google.com/o/oauth2/v2/auth',
      extra: 'field',
    });
    expect(result.success).toBe(false);
  });
});

describe('oidcCallbackRequestSchema', () => {
  const valid = {
    tenantSlug: 'acme-corp',
    code: 'SplxlOBeZQQYbYS6WxSbIA',
    state: 'af0ifjsldkj',
  };

  it('accepts a valid callback payload', () => {
    const result = oidcCallbackRequestSchema.safeParse(valid);
    expect(result.success).toBe(true);
  });

  it('rejects an empty code', () => {
    const result = oidcCallbackRequestSchema.safeParse({ ...valid, code: '' });
    expect(result.success).toBe(false);
  });

  it('rejects an empty state', () => {
    const result = oidcCallbackRequestSchema.safeParse({ ...valid, state: '' });
    expect(result.success).toBe(false);
  });

  it('rejects missing code', () => {
    const { code: _code, ...rest } = valid;
    const result = oidcCallbackRequestSchema.safeParse(rest);
    expect(result.success).toBe(false);
  });

  it('rejects missing state', () => {
    const { state: _state, ...rest } = valid;
    const result = oidcCallbackRequestSchema.safeParse(rest);
    expect(result.success).toBe(false);
  });

  it('rejects an invalid tenantSlug (reuses tenantPublicIdSchema)', () => {
    const result = oidcCallbackRequestSchema.safeParse({ ...valid, tenantSlug: '-bad-start' });
    expect(result.success).toBe(false);
  });

  it('rejects extra fields (strict)', () => {
    const result = oidcCallbackRequestSchema.safeParse({ ...valid, extra: 'field' });
    expect(result.success).toBe(false);
  });

  it('rejects a code that exceeds 4096 characters', () => {
    const result = oidcCallbackRequestSchema.safeParse({ ...valid, code: 'a'.repeat(4097) });
    expect(result.success).toBe(false);
  });

  it('rejects a state that exceeds 1024 characters', () => {
    const result = oidcCallbackRequestSchema.safeParse({ ...valid, state: 'a'.repeat(1025) });
    expect(result.success).toBe(false);
  });
});
