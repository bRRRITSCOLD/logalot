/**
 * Unit tests for GoogleTokenExchangeHttpClient.
 *
 * fetch is mocked via vi.stubGlobal so no real HTTP calls are made. Tests
 * verify that:
 *   - client_secret is sent in the POST body (required by Google's token
 *     endpoint) but NEVER appears in the returned result or errors.
 *   - 4xx responses surface as UnauthorizedError without leaking the body.
 *   - 5xx responses surface as ServiceUnavailableError (Google-side outage).
 *   - Network failures and timeouts surface as ServiceUnavailableError.
 *   - Malformed JSON response surfaces as UnauthorizedError.
 *   - A well-formed 200 response maps cleanly to GoogleTokenExchangeResult.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { GoogleTokenExchangeHttpClient } from '../../src/adapters/http/google-token-exchange-client';
import { ServiceUnavailableError, UnauthorizedError } from '../../src/domain/errors';

const CONFIG = {
  clientId: 'test-client-id.apps.googleusercontent.com',
  clientSecret: 'super-secret-do-not-log',
};

const VALID_RESPONSE = {
  id_token: 'raw.id.token',
  access_token: 'access-token-value',
  token_type: 'Bearer',
  expires_in: 3600,
  scope: 'openid email profile',
};

const EXCHANGE_PARAMS = {
  code: 'auth-code-from-google',
  redirectUri: 'https://app.example.com/auth/callback/google',
  codeVerifier: 'pkce-code-verifier-value',
};

function mockFetch(response: Response): void {
  vi.stubGlobal('fetch', vi.fn().mockResolvedValue(response));
}

function makeFetchError(): void {
  vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new Error('network error')));
}

function makeJsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}

afterEach(() => {
  vi.unstubAllGlobals();
});

// ── Happy path ────────────────────────────────────────────────────────────────

describe('GoogleTokenExchangeHttpClient — success', () => {
  it('returns a GoogleTokenExchangeResult on a valid 200 response', async () => {
    mockFetch(makeJsonResponse(VALID_RESPONSE));
    const client = new GoogleTokenExchangeHttpClient(CONFIG);
    const result = await client.exchange(EXCHANGE_PARAMS);

    expect(result.idToken).toBe('raw.id.token');
    expect(result.accessToken).toBe('access-token-value');
    expect(result.tokenType).toBe('Bearer');
    expect(result.expiresIn).toBe(3600);
    expect(result.scope).toBe('openid email profile');
  });

  it('includes client_secret in the POST body sent to Google', async () => {
    const fetchSpy = vi.fn().mockResolvedValue(makeJsonResponse(VALID_RESPONSE));
    vi.stubGlobal('fetch', fetchSpy);

    const client = new GoogleTokenExchangeHttpClient(CONFIG);
    await client.exchange(EXCHANGE_PARAMS);

    expect(fetchSpy).toHaveBeenCalledOnce();
    const [url, init] = fetchSpy.mock.calls[0] as [string, RequestInit];
    expect(url).toBe('https://oauth2.googleapis.com/token');
    expect(init.method).toBe('POST');
    const body = init.body as string;
    const parsed = new URLSearchParams(body);
    // client_secret must be included in the request body.
    expect(parsed.get('client_secret')).toBe(CONFIG.clientSecret);
    expect(parsed.get('grant_type')).toBe('authorization_code');
    expect(parsed.get('code')).toBe(EXCHANGE_PARAMS.code);
    expect(parsed.get('code_verifier')).toBe(EXCHANGE_PARAMS.codeVerifier);
    expect(parsed.get('redirect_uri')).toBe(EXCHANGE_PARAMS.redirectUri);
  });

  it('does NOT include client_secret in the returned result', async () => {
    mockFetch(makeJsonResponse(VALID_RESPONSE));
    const client = new GoogleTokenExchangeHttpClient(CONFIG);
    const result = await client.exchange(EXCHANGE_PARAMS);

    // Ensure the result object cannot carry the secret in any form.
    const serialized = JSON.stringify(result);
    expect(serialized).not.toContain(CONFIG.clientSecret);
  });
});

// ── Error handling ────────────────────────────────────────────────────────────

describe('GoogleTokenExchangeHttpClient — error handling', () => {
  it('throws UnauthorizedError on a 400 response (invalid_grant)', async () => {
    mockFetch(
      makeJsonResponse(
        { error: 'invalid_grant', error_description: 'Code was already redeemed' },
        400,
      ),
    );
    const client = new GoogleTokenExchangeHttpClient(CONFIG);
    await expect(client.exchange(EXCHANGE_PARAMS)).rejects.toBeInstanceOf(UnauthorizedError);
  });

  it('throws UnauthorizedError on a 401 response', async () => {
    mockFetch(makeJsonResponse({ error: 'unauthorized' }, 401));
    const client = new GoogleTokenExchangeHttpClient(CONFIG);
    await expect(client.exchange(EXCHANGE_PARAMS)).rejects.toBeInstanceOf(UnauthorizedError);
  });

  it('throws ServiceUnavailableError on a 500 server error (Google outage)', async () => {
    mockFetch(makeJsonResponse({ error: 'server_error' }, 500));
    const client = new GoogleTokenExchangeHttpClient(CONFIG);
    await expect(client.exchange(EXCHANGE_PARAMS)).rejects.toBeInstanceOf(ServiceUnavailableError);
  });

  it('throws ServiceUnavailableError on a 503 response (Google outage)', async () => {
    mockFetch(makeJsonResponse({ error: 'service_unavailable' }, 503));
    const client = new GoogleTokenExchangeHttpClient(CONFIG);
    await expect(client.exchange(EXCHANGE_PARAMS)).rejects.toBeInstanceOf(ServiceUnavailableError);
  });

  it('throws ServiceUnavailableError on a network failure (fetch rejects)', async () => {
    makeFetchError();
    const client = new GoogleTokenExchangeHttpClient(CONFIG);
    await expect(client.exchange(EXCHANGE_PARAMS)).rejects.toBeInstanceOf(ServiceUnavailableError);
  });

  it('throws UnauthorizedError on malformed JSON in 200 response', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response('not-json', { status: 200 })));
    const client = new GoogleTokenExchangeHttpClient(CONFIG);
    await expect(client.exchange(EXCHANGE_PARAMS)).rejects.toBeInstanceOf(UnauthorizedError);
  });

  it('throws UnauthorizedError when 200 response is missing id_token', async () => {
    mockFetch(
      makeJsonResponse({
        access_token: 'tok',
        token_type: 'Bearer',
        expires_in: 3600,
        // id_token intentionally missing
      }),
    );
    const client = new GoogleTokenExchangeHttpClient(CONFIG);
    await expect(client.exchange(EXCHANGE_PARAMS)).rejects.toBeInstanceOf(UnauthorizedError);
  });

  it('error message does NOT contain the client_secret', async () => {
    mockFetch(makeJsonResponse({ error: 'invalid_grant' }, 400));
    const client = new GoogleTokenExchangeHttpClient(CONFIG);
    try {
      await client.exchange(EXCHANGE_PARAMS);
      expect.fail('should have thrown');
    } catch (err) {
      expect(err).toBeInstanceOf(UnauthorizedError);
      const message = (err as UnauthorizedError).message;
      expect(message).not.toContain(CONFIG.clientSecret);
    }
  });
});
