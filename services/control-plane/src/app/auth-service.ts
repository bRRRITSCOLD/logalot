import { normalizeEmail } from '../domain/email';
import { UnauthorizedError } from '../domain/errors';
import { assembleRefreshToken, parseRefreshToken } from '../domain/refresh-token';
import { constantTimeEqual, sha256 } from '../domain/secret-hash';
import type {
  Clock,
  IdGenerator,
  PasswordHasher,
  RefreshTokenRepository,
  SecretGenerator,
  SessionTokens,
  TenantRepository,
  TokenService,
  UserRepository,
} from './ports';

export interface LoginCommand {
  // Tenant slug (tenants.public_id). Login is tenant-scoped: the slug selects
  // which tenant's user table the credential authenticates against and arms RLS
  // for the lookup — analogous to the slug embedded in an API key (model.md §4.5).
  // Emails are unique only per tenant, so the slug disambiguates.
  tenantSlug: string;
  email: string;
  password: string;
}

export interface AuthDeps {
  tenants: TenantRepository;
  users: UserRepository;
  refreshTokens: RefreshTokenRepository;
  hasher: PasswordHasher;
  tokens: TokenService;
  secrets: SecretGenerator;
  ids: IdGenerator;
  clock: Clock;
  refreshTtlSeconds: number;
}

// A throwaway value hashed (via the injected hasher, at its configured cost) to
// keep login timing roughly constant whether or not the user exists — mitigating
// user-enumeration via timing. Derived at the configured BCRYPT_COST rather than a
// hardcoded-cost literal, so the dummy verify takes the SAME time as a real one.
const DUMMY_SECRET = 'logalot-nonexistent-user-timing-equalizer';

// AuthService owns UI session establishment (ADR-0007): password login → a
// short-lived stateless access JWT + a stateful ROTATING refresh token, refresh
// with family-based reuse detection, and logout (family revoke). It never logs
// secrets and returns ONE generic error for every authentication failure so it
// leaks no information about which factor failed.
export class AuthService {
  constructor(private readonly deps: AuthDeps) {}

  // Memoized dummy hash, computed once via the injected hasher so its bcrypt cost
  // matches real password hashes (configured BCRYPT_COST). Lazy + cached: the cost
  // is paid once, then reused for every nonexistent-user login.
  private dummyHashPromise: Promise<string> | undefined;
  private dummyHash(): Promise<string> {
    this.dummyHashPromise ??= this.deps.hasher.hash(DUMMY_SECRET);
    return this.dummyHashPromise;
  }

  async login(cmd: LoginCommand): Promise<SessionTokens> {
    const tenant = await this.deps.tenants.findByPublicId(cmd.tenantSlug);
    // Resolve credentials even when tenant/user is missing, then run a constant
    // dummy verify, so a missing tenant/user is timing-indistinguishable from a
    // wrong password.
    const record =
      tenant && tenant.status === 'active'
        ? await this.deps.users.findCredentialsByEmail(tenant.id, normalizeEmail(cmd.email))
        : null;

    const passwordHash = record?.passwordHash ?? (await this.dummyHash());
    const ok = await this.deps.hasher.verify(cmd.password, passwordHash);
    if (!tenant || !record || !ok) {
      throw new UnauthorizedError();
    }
    if (record.status !== 'active' || record.role === null) {
      throw new UnauthorizedError();
    }

    const familyId = this.deps.ids.uuid();
    const refreshToken = await this.mintRefreshToken(tenant.id, record.id, familyId);
    const access = await this.deps.tokens.issueAccess({
      tenantId: tenant.id,
      principalId: record.id,
      role: record.role,
    });
    return {
      accessToken: access.token,
      refreshToken,
      expiresIn: access.expiresInSeconds,
      tokenType: 'Bearer',
      role: record.role,
      tenantId: tenant.id,
      userId: record.id,
    };
  }

  // refresh rotates the session. It verifies the presented refresh token, then:
  //   * a token that is already rotated or revoked => REUSE/theft: the whole
  //     family is revoked and the request is rejected (a legitimate client only
  //     ever holds the newest token).
  //   * an expired token is rejected.
  //   * a SUSPENDED/DELETED tenant cannot refresh; its family is revoked (login
  //     enforces tenant.status === 'active', so refresh must too, else a suspended
  //     tenant could refresh forever).
  //   * a deactivated user (or one stripped of its role) cannot refresh; its
  //     family is revoked.
  // On success it ATOMICALLY consumes the presented token and mints a successor in
  // the SAME family (one tx — see RefreshTokenRepository.rotate), and issues a
  // fresh access JWT. The atomic consume is the TOCTOU guard: of two concurrent
  // presentations of the same token, exactly one wins; the loser is treated as
  // reuse and the family is revoked.
  async refresh(rawToken: string): Promise<SessionTokens> {
    const parsed = this.safeParse(rawToken);
    const row = await this.deps.refreshTokens.findById(parsed.tenantId, parsed.tokenId);
    if (!row || !constantTimeEqual(sha256(parsed.secret), row.tokenHash)) {
      throw new UnauthorizedError('invalid refresh token');
    }

    const now = this.deps.clock.now();
    if (row.revokedAt !== null || row.rotatedAt !== null) {
      // Reuse of a superseded/revoked token: revoke the entire family.
      await this.deps.refreshTokens.revokeFamily(parsed.tenantId, row.familyId, now);
      throw new UnauthorizedError('invalid refresh token');
    }
    if (row.expiresAt.getTime() <= now.getTime()) {
      throw new UnauthorizedError('invalid refresh token');
    }

    const tenant = await this.deps.tenants.findById(parsed.tenantId);
    if (tenant?.status !== 'active') {
      await this.deps.refreshTokens.revokeFamily(parsed.tenantId, row.familyId, now);
      throw new UnauthorizedError('invalid refresh token');
    }

    const record = await this.deps.users.findCredentialsById(parsed.tenantId, row.userId);
    if (record?.status !== 'active' || record.role === null) {
      await this.deps.refreshTokens.revokeFamily(parsed.tenantId, row.familyId, now);
      throw new UnauthorizedError('invalid refresh token');
    }

    // Atomically consume the presented token and mint its successor (one tx).
    const secret = this.deps.secrets.generate();
    const expiresAt = new Date(now.getTime() + this.deps.refreshTtlSeconds * 1000);
    const successor = await this.deps.refreshTokens.rotate(parsed.tenantId, row.id, now, {
      familyId: row.familyId,
      userId: row.userId,
      tokenHash: sha256(secret),
      expiresAt,
    });
    if (!successor) {
      // Lost the rotation race (or a concurrent reuse): treat as theft signal.
      await this.deps.refreshTokens.revokeFamily(parsed.tenantId, row.familyId, now);
      throw new UnauthorizedError('invalid refresh token');
    }

    const access = await this.deps.tokens.issueAccess({
      tenantId: parsed.tenantId,
      principalId: record.id,
      role: record.role,
    });
    return {
      accessToken: access.token,
      refreshToken: assembleRefreshToken(parsed.tenantId, successor.id, secret),
      expiresIn: access.expiresInSeconds,
      tokenType: 'Bearer',
      role: record.role,
      tenantId: parsed.tenantId,
      userId: record.id,
    };
  }

  // logout revokes the presented token's whole family. It is idempotent and never
  // reveals whether the token was valid (always succeeds for the caller).
  async logout(rawToken: string): Promise<void> {
    let parsed: ReturnType<typeof parseRefreshToken>;
    try {
      parsed = parseRefreshToken(rawToken);
    } catch {
      return;
    }
    const now = this.deps.clock.now();
    const row = await this.deps.refreshTokens.findById(parsed.tenantId, parsed.tokenId);
    if (row && constantTimeEqual(sha256(parsed.secret), row.tokenHash)) {
      await this.deps.refreshTokens.revokeFamily(parsed.tenantId, row.familyId, now);
    }
  }

  private async mintRefreshToken(
    tenantId: string,
    userId: string,
    familyId: string,
  ): Promise<string> {
    const secret = this.deps.secrets.generate();
    const expiresAt = new Date(
      this.deps.clock.now().getTime() + this.deps.refreshTtlSeconds * 1000,
    );
    const { id } = await this.deps.refreshTokens.create(tenantId, {
      familyId,
      userId,
      tokenHash: sha256(secret),
      expiresAt,
    });
    return assembleRefreshToken(tenantId, id, secret);
  }

  // safeParse converts a malformed-token ValidationError into a generic 401, so a
  // malformed refresh token looks identical to a wrong one.
  private safeParse(rawToken: string): ReturnType<typeof parseRefreshToken> {
    try {
      return parseRefreshToken(rawToken);
    } catch {
      throw new UnauthorizedError('invalid refresh token');
    }
  }
}
