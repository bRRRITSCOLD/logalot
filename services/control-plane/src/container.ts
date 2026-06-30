import type { Redis } from 'ioredis';
import type { Pool } from 'pg';
import { ConsoleInviteAuditLogger } from './adapters/audit/console-invite-audit-logger';
import { ConsoleOAuthAuditLogger } from './adapters/audit/console-oauth-audit-logger';
import { BcryptHasher } from './adapters/crypto/bcrypt-hasher';
import { JoseGoogleIdTokenVerifier } from './adapters/crypto/jose-google-verifier';
import { JoseTokenService } from './adapters/crypto/jose-token-service';
import { NodeKeyMaterialGenerator } from './adapters/crypto/node-key-material';
import { NodeIdGenerator, NodeSecretGenerator } from './adapters/crypto/node-random';
import { SystemClock } from './adapters/crypto/system-clock';
import { NoOpEmailSender } from './adapters/email/noop-email-sender';
import { SmtpEmailSender } from './adapters/email/smtp-email-sender';
import { GoogleTokenExchangeHttpClient } from './adapters/http/google-token-exchange-client';
import { PgAlertRuleRepository } from './adapters/postgres/alert-rule-repository';
import { PgApiKeyRepository } from './adapters/postgres/api-key-repository';
import { PgDashboardRepository } from './adapters/postgres/dashboard-repository';
import { PgInviteRepository } from './adapters/postgres/invite-repository';
import { PgOAuthIdentityRepository } from './adapters/postgres/oauth-identity-repository';
import { PgRefreshTokenRepository } from './adapters/postgres/refresh-token-repository';
import { PgRetentionRepository } from './adapters/postgres/retention-repository';
import { PgSavedQueryRepository } from './adapters/postgres/saved-query-repository';
import { PgTenantRepository } from './adapters/postgres/tenant-repository';
import { PgUserRepository } from './adapters/postgres/user-repository';
import { createRedisClient } from './adapters/redis/client';
import { InMemoryOAuthStateStore } from './adapters/redis/in-memory-oauth-state-store';
import { RedisOAuthStateStore } from './adapters/redis/redis-oauth-state-store';
import { AlertRuleService } from './app/alert-rule-service';
import { ApiKeyService } from './app/api-key-service';
import { AuthService } from './app/auth-service';
import { DashboardService } from './app/dashboard-service';
import { InviteService } from './app/invite-service';
import { OidcAuthenticator } from './app/oidc-authenticator';
import type {
  EmailSender,
  GoogleIdTokenVerifier,
  GoogleTokenExchangeClient,
  OAuthStateStore,
  TokenService,
} from './app/ports';
import { RetentionService } from './app/retention-service';
import { SavedQueryService } from './app/saved-query-service';
import { TenantService } from './app/tenant-service';
import { UserService } from './app/user-service';
import type { Config } from './config/env';

// Services is the bundle the HTTP layer drives. Grouping them keeps the route
// wiring (server.ts) decoupled from how each service is constructed.
export interface Services {
  auth: AuthService;
  tenants: TenantService;
  users: UserService;
  apiKeys: ApiKeyService;
  retention: RetentionService;
  alerts: AlertRuleService;
  savedQueries: SavedQueryService;
  dashboards: DashboardService;
  invites: InviteService;
}

export interface Container {
  services: Services;
  tokenService: TokenService;
  oauthStateStore: OAuthStateStore;
  /** Google id_token verifier — undefined when GOOGLE_CLIENT_ID is not configured. */
  googleIdTokenVerifier: GoogleIdTokenVerifier | undefined;
  /** Google token-exchange client — undefined when Google config is incomplete. */
  googleTokenExchangeClient: GoogleTokenExchangeClient | undefined;
  oidcAuthenticator: OidcAuthenticator;
  /**
   * The shared ioredis client — exposed so the HTTP layer can wire it into
   * @fastify/rate-limit's Redis-backed store (shared per-IP counters across
   * replicas).  Undefined when REDIS_URL is not configured (dev/test: use
   * the rate-limit plugin's default in-memory store).
   */
  redisClient: Redis | undefined;
  /**
   * Outbound email adapter selected at startup from EMAIL_PROVIDER (ADR-0013).
   * 'none' / unset → NoOpEmailSender (default, no network calls).
   * 'smtp'         → SmtpEmailSender (nodemailer; requires SMTP_* config).
   * Exposed so InviteService (Task 12) and future services can inject it.
   */
  emailSender: EmailSender;
  /** Release infrastructure resources (Redis connection, etc.) on graceful shutdown. */
  shutdown: () => Promise<void>;
}

// buildContainer is the composition root: it wires the concrete adapters into the
// application services. This is the ONLY place that knows both the ports and their
// implementations — everything else depends on interfaces (ports-and-adapters /
// dependency inversion).
export function buildContainer(pool: Pool, config: Config): Container {
  const hasher = new BcryptHasher(config.bcryptCost);
  const tokenService = new JoseTokenService({
    secret: config.jwtSecret,
    accessTtlSeconds: config.accessTokenTtlSeconds,
  });
  const keyGenerator = new NodeKeyMaterialGenerator();
  const secretGenerator = new NodeSecretGenerator();
  const idGenerator = new NodeIdGenerator();
  const clock = new SystemClock();

  const tenantRepo = new PgTenantRepository(pool);
  const userRepo = new PgUserRepository(pool);
  const apiKeyRepo = new PgApiKeyRepository(pool);
  const retentionRepo = new PgRetentionRepository(pool);
  const refreshTokenRepo = new PgRefreshTokenRepository(pool);
  const alertRuleRepo = new PgAlertRuleRepository(pool);
  const savedQueryRepo = new PgSavedQueryRepository(pool);
  const dashboardRepo = new PgDashboardRepository(pool);
  const oauthIdentityRepo = new PgOAuthIdentityRepository(pool);
  const inviteRepo = new PgInviteRepository(pool);

  // Email adapter — selected from EMAIL_PROVIDER; NEVER derived from request data
  // (ADR-0013, R-INV-14). NoOpEmailSender is the safe default (no network I/O).
  // Constructed before services so InviteService can receive it at composition time.
  const emailSender: EmailSender =
    config.emailProvider === 'smtp' && config.smtpHost && config.smtpPort && config.smtpFrom
      ? new SmtpEmailSender({
          host: config.smtpHost,
          port: config.smtpPort,
          user: config.smtpUser,
          pass: config.smtpPass,
          from: config.smtpFrom,
        })
      : new NoOpEmailSender();

  const services: Services = {
    auth: new AuthService({
      tenants: tenantRepo,
      users: userRepo,
      refreshTokens: refreshTokenRepo,
      hasher,
      tokens: tokenService,
      secrets: secretGenerator,
      ids: idGenerator,
      clock,
      refreshTtlSeconds: config.refreshTokenTtlSeconds,
    }),
    tenants: new TenantService(tenantRepo, userRepo, hasher),
    users: new UserService(userRepo, hasher),
    apiKeys: new ApiKeyService(apiKeyRepo, tenantRepo, keyGenerator, clock),
    retention: new RetentionService(retentionRepo),
    alerts: new AlertRuleService(alertRuleRepo),
    savedQueries: new SavedQueryService(savedQueryRepo),
    dashboards: new DashboardService(dashboardRepo),
    invites: new InviteService(
      inviteRepo,
      tenantRepo,
      secretGenerator,
      clock,
      emailSender,
      new ConsoleInviteAuditLogger(),
      {
        inviteTtlSeconds: config.inviteTtlSeconds,
        inviteMaxOutstandingPerTenant: config.inviteMaxOutstandingPerTenant,
        inviteAcceptBaseUrl: config.inviteAcceptBaseUrl,
      },
    ),
  };

  // OAuth state store — Redis when REDIS_URL is configured, in-memory fake otherwise.
  // The in-memory store is safe for single-process dev/test; use Redis in production
  // and any multi-replica deployment so state survives between request handlers.
  //
  // The Redis client is retained so the composition root can close the connection on
  // graceful shutdown (see the `shutdown` field). The caller is responsible for
  // invoking container.shutdown() before process exit.
  const redisClient = config.redisUrl ? createRedisClient(config.redisUrl) : undefined;
  const oauthStateStore: OAuthStateStore = redisClient
    ? new RedisOAuthStateStore(redisClient)
    : new InMemoryOAuthStateStore();

  // Google OAuth adapters — only wired when both client_id and client_secret are
  // configured. Absence in dev/test is expected; routes guard against undefined.
  const googleIdTokenVerifier: GoogleIdTokenVerifier | undefined = config.googleClientId
    ? new JoseGoogleIdTokenVerifier({ clientId: config.googleClientId })
    : undefined;

  const googleTokenExchangeClient: GoogleTokenExchangeClient | undefined =
    config.googleClientId && config.googleClientSecret
      ? new GoogleTokenExchangeHttpClient({
          clientId: config.googleClientId,
          clientSecret: config.googleClientSecret,
        })
      : undefined;
  // OidcAuthenticator — beginAuthorize (issue #95) + handleCallback (issue #96) +
  // account-linking + audit (issue #97).
  // clientId and redirectUri are required in production; they are optional in
  // config so tests that don't exercise the OIDC path don't need to provide them.
  // The callback-half deps (tokenExchangeClient, idTokenVerifier, oauthIdentities)
  // may be undefined in dev/test environments that lack Google credentials; the
  // route is guarded at the HTTP layer.
  const oidcAuthenticator = new OidcAuthenticator({
    tenants: tenantRepo,
    stateStore: oauthStateStore,
    clientId: config.googleOidcClientId ?? '',
    redirectUri: config.googleOidcRedirectUri ?? config.googleRedirectUri ?? '',
    authEndpoint: config.googleOidcAuthEndpoint,
    stateTtlSeconds: config.oauthStateTtlSeconds,
    // Callback-half deps — fall back to stubs that throw when Google config is
    // absent. The stubs satisfy the type; the route/service will propagate the
    // error as a 401 (exchange/verify failure) rather than crashing at startup.
    tokenExchangeClient: googleTokenExchangeClient ?? {
      exchange: () => Promise.reject(new Error('Google token exchange not configured')),
    },
    idTokenVerifier: googleIdTokenVerifier ?? {
      verify: () => Promise.reject(new Error('Google id_token verifier not configured')),
    },
    oauthIdentities: oauthIdentityRepo,
    users: userRepo,
    refreshTokens: refreshTokenRepo,
    tokens: tokenService,
    secrets: secretGenerator,
    ids: idGenerator,
    clock,
    refreshTtlSeconds: config.refreshTokenTtlSeconds,
    // Structured audit logger — ConsoleOAuthAuditLogger writes one JSON line per
    // callback outcome to stderr (privacy-safe: only hashed sub is logged).
    auditLogger: new ConsoleOAuthAuditLogger(),
  });

  return {
    services,
    tokenService,
    oauthStateStore,
    googleIdTokenVerifier,
    googleTokenExchangeClient,
    oidcAuthenticator,
    redisClient,
    emailSender,
    shutdown: async () => {
      if (redisClient) await redisClient.quit();
    },
  };
}
