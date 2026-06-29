/**
 * Unit tests for JoseGoogleIdTokenVerifier.
 *
 * All tests use a locally generated RSA key pair + createLocalJWKSet so no HTTP
 * calls are made (the JWKS getter is injected via the `jwksGetKey` config option).
 * A second key pair ("rotated") is used to test JWKS-rotation behaviour.
 */
import {
  type JWK,
  type KeyLike,
  SignJWT,
  createLocalJWKSet,
  exportJWK,
  generateKeyPair,
} from 'jose';
import { beforeAll, describe, expect, it } from 'vitest';
import {
  JoseGoogleIdTokenVerifier,
  type JwksGetKey,
} from '../../src/adapters/crypto/jose-google-verifier';
import { UnauthorizedError } from '../../src/domain/errors';

// ── Test fixtures ─────────────────────────────────────────────────────────────

const CLIENT_ID = 'test-client-id-123.apps.googleusercontent.com';
const NONCE = 'test-nonce-abc123';
const GOOGLE_ISS = 'https://accounts.google.com';

interface KeyFixture {
  kid: string;
  privateKey: KeyLike;
  publicJwk: JWK;
}

async function generateRsaKeyPair(kid: string): Promise<KeyFixture> {
  const { privateKey, publicKey } = await generateKeyPair('RS256');
  const publicJwk: JWK = { ...(await exportJWK(publicKey)), kid, alg: 'RS256', use: 'sig' };
  return { kid, privateKey, publicJwk };
}

// Builds a verifier whose JWKS getter is backed by a local key set from the
// given public JWKs. This avoids any HTTP calls in tests.
function buildVerifier(publicJwks: JWK[]): JoseGoogleIdTokenVerifier {
  const localJwks = createLocalJWKSet({ keys: publicJwks });
  return new JoseGoogleIdTokenVerifier({
    clientId: CLIENT_ID,
    jwksGetKey: localJwks as unknown as JwksGetKey,
  });
}

// Signs a minimal Google-like id_token with the given private key.
async function signIdToken(
  privateKey: KeyLike,
  kid: string,
  overrides: Record<string, unknown> = {},
  algOverride = 'RS256',
): Promise<string> {
  const base = {
    iss: GOOGLE_ISS,
    aud: CLIENT_ID,
    sub: 'google-sub-12345',
    email: 'user@example.com',
    email_verified: true,
    nonce: NONCE,
    iat: Math.floor(Date.now() / 1000) - 5,
    exp: Math.floor(Date.now() / 1000) + 300,
  };
  const claims = { ...base, ...overrides };

  // Build the JWT — we set alg in the header so we can override it for HS/none tests.
  const builder = new SignJWT(claims)
    .setProtectedHeader({ alg: algOverride, kid })
    .setIssuedAt()
    .setExpirationTime('5m');

  return builder.sign(privateKey);
}

// ── Fixture bootstrap ─────────────────────────────────────────────────────────

let primary: KeyFixture;
let rotated: KeyFixture;

beforeAll(async () => {
  primary = await generateRsaKeyPair('kid-primary');
  rotated = await generateRsaKeyPair('kid-rotated');
});

// ── Happy path ────────────────────────────────────────────────────────────────

describe('JoseGoogleIdTokenVerifier — valid token', () => {
  it('returns the verified claims for a well-formed RS256 id_token', async () => {
    const verifier = buildVerifier([primary.publicJwk]);
    const token = await signIdToken(primary.privateKey, primary.kid);
    const claims = await verifier.verify(token, NONCE);

    expect(claims.sub).toBe('google-sub-12345');
    expect(claims.email).toBe('user@example.com');
    expect(claims.email_verified).toBe(true);
    expect(claims.nonce).toBe(NONCE);
    expect(claims.iss).toBe(GOOGLE_ISS);
    expect(claims.aud).toBe(CLIENT_ID);
  });
});

// ── Signature / algorithm checks ──────────────────────────────────────────────

describe('JoseGoogleIdTokenVerifier — signature / algorithm rejection', () => {
  it('rejects a token signed with a key not in the JWKS (bad/absent sig)', async () => {
    const verifier = buildVerifier([primary.publicJwk]);
    // Sign with rotated key but the verifier only knows about primary.
    const token = await signIdToken(rotated.privateKey, rotated.kid);
    await expect(verifier.verify(token, NONCE)).rejects.toBeInstanceOf(UnauthorizedError);
  });

  it('rejects a tampered token (payload modified after signing)', async () => {
    const verifier = buildVerifier([primary.publicJwk]);
    const token = await signIdToken(primary.privateKey, primary.kid);
    // Flip one character in the payload section (middle part).
    const [header, payload, sig] = token.split('.');
    const tamperedPayload = payload!.slice(0, -1) + (payload!.slice(-1) === 'A' ? 'B' : 'A');
    const tampered = `${header}.${tamperedPayload}.${sig}`;
    await expect(verifier.verify(tampered, NONCE)).rejects.toBeInstanceOf(UnauthorizedError);
  });

  it('rejects alg:none (unsigned token)', async () => {
    const verifier = buildVerifier([primary.publicJwk]);
    // Manually craft a "none" token — jose will reject it at the algorithm check.
    const header = Buffer.from(JSON.stringify({ alg: 'none', kid: primary.kid })).toString(
      'base64url',
    );
    const payload = Buffer.from(
      JSON.stringify({
        iss: GOOGLE_ISS,
        aud: CLIENT_ID,
        sub: 'google-sub-12345',
        email: 'user@example.com',
        email_verified: true,
        nonce: NONCE,
        exp: Math.floor(Date.now() / 1000) + 300,
        iat: Math.floor(Date.now() / 1000) - 5,
      }),
    ).toString('base64url');
    const noneToken = `${header}.${payload}.`;
    await expect(verifier.verify(noneToken, NONCE)).rejects.toBeInstanceOf(UnauthorizedError);
  });

  it('rejects alg:HS256 (symmetric algorithm — RS256 is the only allowed alg)', async () => {
    // Generate an HS256 token using a symmetric secret.
    const secret = new TextEncoder().encode('super-secret-hmac-key');
    const hsToken = await new SignJWT({
      iss: GOOGLE_ISS,
      aud: CLIENT_ID,
      sub: 'google-sub-12345',
      email: 'user@example.com',
      email_verified: true,
      nonce: NONCE,
    })
      .setProtectedHeader({ alg: 'HS256', kid: primary.kid })
      .setIssuedAt()
      .setExpirationTime('5m')
      .sign(secret);

    const verifier = buildVerifier([primary.publicJwk]);
    await expect(verifier.verify(hsToken, NONCE)).rejects.toBeInstanceOf(UnauthorizedError);
  });
});

// ── Claim validation ──────────────────────────────────────────────────────────

describe('JoseGoogleIdTokenVerifier — claim validation', () => {
  it('rejects a token with wrong issuer', async () => {
    const verifier = buildVerifier([primary.publicJwk]);
    const token = await signIdToken(primary.privateKey, primary.kid, {
      iss: 'https://evil.example.com',
    });
    await expect(verifier.verify(token, NONCE)).rejects.toBeInstanceOf(UnauthorizedError);
  });

  it('rejects a token with wrong audience', async () => {
    const verifier = buildVerifier([primary.publicJwk]);
    const token = await signIdToken(primary.privateKey, primary.kid, {
      aud: 'other-client-id.apps.googleusercontent.com',
    });
    await expect(verifier.verify(token, NONCE)).rejects.toBeInstanceOf(UnauthorizedError);
  });

  it('rejects an expired token (exp in the past)', async () => {
    const verifier = buildVerifier([primary.publicJwk]);
    // Build the token directly so we control exp without the builder overriding it.
    const now = Math.floor(Date.now() / 1000);
    const expiredToken = await new SignJWT({
      iss: GOOGLE_ISS,
      aud: CLIENT_ID,
      sub: 'google-sub-12345',
      email: 'user@example.com',
      email_verified: true,
      nonce: NONCE,
      iat: now - 600,
      exp: now - 300, // already expired — NOT using setExpirationTime
    })
      .setProtectedHeader({ alg: 'RS256', kid: primary.kid })
      .sign(primary.privateKey);
    await expect(verifier.verify(expiredToken, NONCE)).rejects.toBeInstanceOf(UnauthorizedError);
  });

  it('rejects a token with email_verified:false', async () => {
    const verifier = buildVerifier([primary.publicJwk]);
    const token = await signIdToken(primary.privateKey, primary.kid, {
      email_verified: false,
    });
    await expect(verifier.verify(token, NONCE)).rejects.toBeInstanceOf(UnauthorizedError);
  });

  it('rejects a token with missing email_verified field', async () => {
    const verifier = buildVerifier([primary.publicJwk]);
    // We can't remove a field from the SignJWT builder directly, so build raw.
    const rawPayload = {
      iss: GOOGLE_ISS,
      aud: CLIENT_ID,
      sub: 'google-sub-12345',
      email: 'user@example.com',
      // email_verified intentionally omitted
      nonce: NONCE,
      exp: Math.floor(Date.now() / 1000) + 300,
      iat: Math.floor(Date.now() / 1000) - 5,
    };
    const token = await new SignJWT(rawPayload)
      .setProtectedHeader({ alg: 'RS256', kid: primary.kid })
      .sign(primary.privateKey);
    await expect(verifier.verify(token, NONCE)).rejects.toBeInstanceOf(UnauthorizedError);
  });

  it('rejects a token with a mismatched nonce', async () => {
    const verifier = buildVerifier([primary.publicJwk]);
    const token = await signIdToken(primary.privateKey, primary.kid, {
      nonce: 'completely-different-nonce',
    });
    await expect(verifier.verify(token, NONCE)).rejects.toBeInstanceOf(UnauthorizedError);
  });

  it('rejects a token with a missing nonce', async () => {
    const verifier = buildVerifier([primary.publicJwk]);
    const rawPayload = {
      iss: GOOGLE_ISS,
      aud: CLIENT_ID,
      sub: 'google-sub-12345',
      email: 'user@example.com',
      email_verified: true,
      // nonce intentionally omitted
      exp: Math.floor(Date.now() / 1000) + 300,
      iat: Math.floor(Date.now() / 1000) - 5,
    };
    const token = await new SignJWT(rawPayload)
      .setProtectedHeader({ alg: 'RS256', kid: primary.kid })
      .sign(primary.privateKey);
    await expect(verifier.verify(token, NONCE)).rejects.toBeInstanceOf(UnauthorizedError);
  });
});

// ── JWKS rotation ─────────────────────────────────────────────────────────────

describe('JoseGoogleIdTokenVerifier — JWKS rotation', () => {
  it('selects the correct key by token kid (two keys in the set)', async () => {
    // Both keys in JWKS — verifier picks the right one via kid matching.
    const verifier = buildVerifier([primary.publicJwk, rotated.publicJwk]);

    const tokenPrimary = await signIdToken(primary.privateKey, primary.kid);
    const tokenRotated = await signIdToken(rotated.privateKey, rotated.kid);

    const claimsPrimary = await verifier.verify(tokenPrimary, NONCE);
    const claimsRotated = await verifier.verify(tokenRotated, NONCE);

    expect(claimsPrimary.sub).toBe('google-sub-12345');
    expect(claimsRotated.sub).toBe('google-sub-12345');
  });

  it('accepts a token signed with the rotated key after the JWKS set is updated', async () => {
    // Simulate key rotation: the "old" verifier only knows primary; a new verifier
    // (after JWKS refetch) knows both. The rotated key validates in the new set.
    const verifierAfterRotation = buildVerifier([primary.publicJwk, rotated.publicJwk]);
    const tokenWithRotatedKey = await signIdToken(rotated.privateKey, rotated.kid);
    const claims = await verifierAfterRotation.verify(tokenWithRotatedKey, NONCE);
    expect(claims.sub).toBe('google-sub-12345');
  });

  it('rejects a token whose kid is not present in the JWKS (unknown kid)', async () => {
    // Verifier only has primary; token was signed with rotated (unknown kid).
    const verifierPrimaryOnly = buildVerifier([primary.publicJwk]);
    const tokenWithRotatedKey = await signIdToken(rotated.privateKey, rotated.kid);
    await expect(verifierPrimaryOnly.verify(tokenWithRotatedKey, NONCE)).rejects.toBeInstanceOf(
      UnauthorizedError,
    );
  });

  it('rejects a token with primary kid but signed with rotated private key (key mismatch)', async () => {
    // Token claims kid=primary but is actually signed with rotated private key —
    // verifier finds the primary public key by kid but signature verification fails.
    const verifier = buildVerifier([primary.publicJwk, rotated.publicJwk]);
    const wrongKeyToken = await signIdToken(
      rotated.privateKey,
      primary.kid, // lie about the kid
    );
    await expect(verifier.verify(wrongKeyToken, NONCE)).rejects.toBeInstanceOf(UnauthorizedError);
  });
});
