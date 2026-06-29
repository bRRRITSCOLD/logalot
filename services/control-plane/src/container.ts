import type { Pool } from 'pg';
import { BcryptHasher } from './adapters/crypto/bcrypt-hasher';
import { JoseTokenService } from './adapters/crypto/jose-token-service';
import { NodeKeyMaterialGenerator } from './adapters/crypto/node-key-material';
import { NodeIdGenerator, NodeSecretGenerator } from './adapters/crypto/node-random';
import { SystemClock } from './adapters/crypto/system-clock';
import { PgAlertRuleRepository } from './adapters/postgres/alert-rule-repository';
import { PgApiKeyRepository } from './adapters/postgres/api-key-repository';
import { PgDashboardRepository } from './adapters/postgres/dashboard-repository';
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
import type { OAuthStateStore, TokenService } from './app/ports';
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
}

export interface Container {
  services: Services;
  tokenService: TokenService;
  oauthStateStore: OAuthStateStore;
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

  return {
    services,
    tokenService,
    oauthStateStore,
    shutdown: async () => {
      if (redisClient) await redisClient.quit();
    },
  };
}
