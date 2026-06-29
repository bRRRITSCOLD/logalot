import { type FlattenedJWSInput, type JWTHeaderParameters, createRemoteJWKSet, jwtVerify } from 'jose';
import type { KeyLike } from 'jose';
import { UnauthorizedError } from '../../domain/errors';
import type { GoogleIdTokenClaims, GoogleIdTokenVerifier } from '../../app/ports';

// Google's canonical OIDC issuers (both are valid per Google's spec).
const GOOGLE_ISSUERS = ['https://accounts.google.com', 'accounts.google.com'] as const;
const GOOGLE_JWKS_URI = 'https://www.googleapis.com/oauth2/v3/certs';

// JwksGetKey is the JOSE compatible JWKS getter type. Accepting it as a
// constructor parameter keeps the production path simple (just pass
// createRemoteJWKSet(uri)) while allowing tests to inject a local JWKS set
// (createLocalJWKSet) without any HTTP calls.
export type JwksGetKey = (
  protectedHeader: JWTHeaderParameters,
  token: FlattenedJWSInput,
) => Promise<KeyLike | Uint8Array<ArrayBufferLike>>;

export interface GoogleVerifierConfig {
  /** Google OAuth 2.0 client id — used as the required `aud` value. */
  clientId: string;
  /**
   * Injectable JWKS getter. Defaults to Google's live JWKS endpoint.
   * Override in tests with `createLocalJWKSet(jwks)` to avoid HTTP calls.
   */
  jwksGetKey?: JwksGetKey;
}

// JoseGoogleIdTokenVerifier verifies Google OIDC id_tokens using jose's
// JWKS-backed RS256 verification. Security guarantees:
//   - RS256 only: none/HS* algorithms are rejected by jose before signature check
//     (the `algorithms` option is an allowlist; any other alg throws JWSInvalid).
//   - Issuer must be a Google canonical issuer value.
//   - Audience must match the configured GOOGLE_CLIENT_ID.
//   - Expiry is checked by jose automatically (throws JWTExpired when past).
//   - email_verified must be true (Google includes this for OAuth scopes).
//   - nonce must match the value the control-plane generated at authorize time.
// The raw id_token and client_secret are NEVER logged or returned.
export class JoseGoogleIdTokenVerifier implements GoogleIdTokenVerifier {
  private readonly getKey: JwksGetKey;
  private readonly clientId: string;

  constructor(config: GoogleVerifierConfig) {
    this.clientId = config.clientId;
    // Default to Google's live JWKS URI; test code injects a local key set.
    this.getKey = config.jwksGetKey ?? (createRemoteJWKSet(new URL(GOOGLE_JWKS_URI)) as JwksGetKey);
  }

  async verify(idToken: string, expectedNonce: string): Promise<GoogleIdTokenClaims> {
    let payload: Record<string, unknown>;
    try {
      const result = await jwtVerify(idToken, this.getKey, {
        // RS256 is the only allowed algorithm — none, HS*, and other algs rejected.
        algorithms: ['RS256'],
        audience: this.clientId,
        issuer: GOOGLE_ISSUERS as unknown as string[],
      });
      payload = result.payload as Record<string, unknown>;
    } catch (err) {
      // Surface jose's typed errors as generic UnauthorizedError so the caller
      // never leaks which specific check failed (timing channels aside, the
      // message is safe to log internally but not to return to the client).
      throw new UnauthorizedError('invalid id_token');
    }

    // email_verified must be explicitly true — absence or false is rejected.
    if (payload['email_verified'] !== true) {
      throw new UnauthorizedError('invalid id_token');
    }

    // Nonce must be present and match the value we generated at authorize time.
    // This binds the id_token to the specific authorization request, preventing
    // replay of a token from a different flow.
    if (typeof payload['nonce'] !== 'string' || payload['nonce'] !== expectedNonce) {
      throw new UnauthorizedError('invalid id_token');
    }

    const email = payload['email'];
    const sub = payload['sub'];
    if (typeof email !== 'string' || typeof sub !== 'string') {
      throw new UnauthorizedError('invalid id_token');
    }

    return {
      sub,
      email,
      email_verified: true,
      nonce: payload['nonce'] as string,
      iss: payload['iss'] as string,
      aud: payload['aud'] as string | string[],
      iat: payload['iat'] as number,
      exp: payload['exp'] as number,
      name: typeof payload['name'] === 'string' ? payload['name'] : undefined,
      picture: typeof payload['picture'] === 'string' ? payload['picture'] : undefined,
    };
  }
}
