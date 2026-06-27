import { SignJWT, jwtVerify } from 'jose';
import { isRole } from '../../domain/roles';
import type { SessionClaims, TokenService } from '../../app/ports';

const ISSUER = 'logalot-control-plane';
const AUDIENCE = 'logalot';
const ALG = 'HS256';

export interface JoseTokenConfig {
  secret: string;
  accessTtlSeconds: number;
}

// JoseTokenService issues and verifies the HS256 access JWT (ADR-0007). The token
// carries { sub=principal_id, tenant_id, role } plus iss/aud/iat/exp — the claim
// set the shared `accessClaimsSchema` contract expects. Verification always checks
// signature, issuer, audience and expiry; a tampered, foreign-signed, or expired
// token is rejected. Access tokens are short-lived and stateless; revocation
// before expiry is the refresh token's job (it is the stateful credential).
export class JoseTokenService implements TokenService {
  private readonly secret: Uint8Array;

  constructor(private readonly config: JoseTokenConfig) {
    this.secret = new TextEncoder().encode(config.secret);
  }

  async issueAccess(claims: SessionClaims): Promise<{ token: string; expiresInSeconds: number }> {
    const token = await new SignJWT({
      tenant_id: claims.tenantId,
      role: claims.role,
    })
      .setProtectedHeader({ alg: ALG })
      .setSubject(claims.principalId)
      .setIssuer(ISSUER)
      .setAudience(AUDIENCE)
      .setIssuedAt()
      .setExpirationTime(`${this.config.accessTtlSeconds}s`)
      .sign(this.secret);
    return { token, expiresInSeconds: this.config.accessTtlSeconds };
  }

  async verifyAccess(token: string): Promise<SessionClaims> {
    const { payload } = await jwtVerify(token, this.secret, {
      issuer: ISSUER,
      audience: AUDIENCE,
      algorithms: [ALG],
    });
    const tenantId = payload.tenant_id;
    const principalId = payload.sub;
    const role = payload.role;
    if (typeof tenantId !== 'string' || typeof principalId !== 'string' || !isRole(role)) {
      throw new Error('malformed token claims');
    }
    return { tenantId, principalId, role };
  }
}
