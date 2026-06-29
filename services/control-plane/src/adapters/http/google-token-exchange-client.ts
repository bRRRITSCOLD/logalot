import { UnauthorizedError } from '../../domain/errors';
import type { GoogleTokenExchangeClient, GoogleTokenExchangeResult } from '../../app/ports';

const GOOGLE_TOKEN_ENDPOINT = 'https://oauth2.googleapis.com/token';

export interface GoogleTokenExchangeConfig {
  /** Google OAuth 2.0 client id. */
  clientId: string;
  /**
   * Google OAuth 2.0 client secret — sourced from SSM in production.
   * NEVER log this value. It is consumed inside this adapter and never returned.
   */
  clientSecret: string;
}

// Shape of Google's /token success response that the auth flow needs.
// Unknown extra fields (scope_granted, id_token, etc.) are present at runtime
// but not typed here — we only extract what the flow uses.
interface GoogleTokenResponse {
  id_token: string;
  access_token: string;
  token_type: string;
  expires_in: number;
  scope?: string;
}

// GoogleTokenExchangeHttpClient exchanges a Google authorization code (PKCE flow)
// for an id_token + access_token pair. The client_secret is injected via config
// and is NEVER logged, returned to callers, or included in error messages.
//
// On a non-2xx response the adapter throws UnauthorizedError so the auth flow
// surfaces a generic 401 — never a raw Google error body (which could leak
// information about the client_secret or authorization state).
export class GoogleTokenExchangeHttpClient implements GoogleTokenExchangeClient {
  constructor(private readonly config: GoogleTokenExchangeConfig) {}

  async exchange(params: {
    code: string;
    redirectUri: string;
    codeVerifier: string;
  }): Promise<GoogleTokenExchangeResult> {
    // Build the POST body — client_secret included here only.
    const body = new URLSearchParams({
      grant_type: 'authorization_code',
      code: params.code,
      redirect_uri: params.redirectUri,
      client_id: this.config.clientId,
      client_secret: this.config.clientSecret,
      code_verifier: params.codeVerifier,
    });

    let response: Response;
    try {
      response = await fetch(GOOGLE_TOKEN_ENDPOINT, {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body: body.toString(),
      });
    } catch {
      // Network-level error (DNS, TLS, timeout). Surface as generic auth error
      // to avoid leaking connectivity details.
      throw new UnauthorizedError('token exchange failed');
    }

    if (!response.ok) {
      // Non-2xx: do NOT include the response body (may contain OAuth error codes
      // that hint at client_secret validity). Log at caller's discretion.
      throw new UnauthorizedError('token exchange failed');
    }

    let data: GoogleTokenResponse;
    try {
      data = (await response.json()) as GoogleTokenResponse;
    } catch {
      throw new UnauthorizedError('token exchange failed');
    }

    if (
      typeof data.id_token !== 'string' ||
      typeof data.access_token !== 'string' ||
      typeof data.token_type !== 'string' ||
      typeof data.expires_in !== 'number'
    ) {
      throw new UnauthorizedError('token exchange failed');
    }

    return {
      idToken: data.id_token,
      accessToken: data.access_token,
      tokenType: data.token_type,
      expiresIn: data.expires_in,
      scope: data.scope,
    };
  }
}
