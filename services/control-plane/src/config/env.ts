import { z } from 'zod';

// Environment configuration, validated with zod at startup so a misconfigured
// service fails fast and loud rather than at first request. The app DB URL must
// point at the NOSUPERUSER logalot_app role (see pool.ts / migration 000011).
const EnvSchema = z.object({
  NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
  CONTROL_PLANE_HOST: z.string().default('0.0.0.0'),
  CONTROL_PLANE_PORT: z.coerce.number().int().positive().default(8082),
  LOGALOT_APP_DATABASE_URL: z.string().min(1, 'LOGALOT_APP_DATABASE_URL is required'),
  // HS256 signing secret for session tokens. Must be set to a strong random value
  // in any non-local environment.
  JWT_SECRET: z.string().min(16, 'JWT_SECRET must be at least 16 characters'),
  ACCESS_TOKEN_TTL_SECONDS: z.coerce.number().int().positive().default(900),
  REFRESH_TOKEN_TTL_SECONDS: z.coerce
    .number()
    .int()
    .positive()
    .default(60 * 60 * 24 * 7),
  BCRYPT_COST: z.coerce.number().int().min(4).max(15).default(10),
  LOG_LEVEL: z.enum(['fatal', 'error', 'warn', 'info', 'debug', 'trace', 'silent']).default('info'),
  // Redis — OAuth in-flight state store (issue #89). Optional: when unset the
  // service falls back to the in-memory store (suitable for single-process dev/test
  // only). Set to a Redis URL in production and any multi-replica deployment.
  REDIS_URL: z.string().optional(),
  OAUTH_STATE_TTL_SECONDS: z.coerce.number().int().positive().default(600),
  // Google OAuth 2.0 / OIDC — required for the Google login flow (issue #94).
  // GOOGLE_CLIENT_SECRET is read from SSM on the deployed box and never logged.
  GOOGLE_CLIENT_ID: z.string().optional(),
  GOOGLE_CLIENT_SECRET: z.string().optional(),
  GOOGLE_REDIRECT_URI: z.string().optional(),
});

export interface Config {
  nodeEnv: 'development' | 'test' | 'production';
  host: string;
  port: number;
  databaseUrl: string;
  jwtSecret: string;
  accessTokenTtlSeconds: number;
  refreshTokenTtlSeconds: number;
  bcryptCost: number;
  logLevel: string;
  /** Redis URL for the OAuth state store. Undefined disables the Redis adapter (use in-memory only for tests). */
  redisUrl: string | undefined;
  oauthStateTtlSeconds: number;
  /** Google OAuth 2.0 client id — public value, safe to log. */
  googleClientId: string | undefined;
  /** Google OAuth 2.0 client secret — NEVER log or expose. */
  googleClientSecret: string | undefined;
  /** Registered redirect URI for the Google OAuth callback. */
  googleRedirectUri: string | undefined;
}

export function loadConfig(env: NodeJS.ProcessEnv = process.env): Config {
  const parsed = EnvSchema.parse(env);
  return {
    nodeEnv: parsed.NODE_ENV,
    host: parsed.CONTROL_PLANE_HOST,
    port: parsed.CONTROL_PLANE_PORT,
    databaseUrl: parsed.LOGALOT_APP_DATABASE_URL,
    jwtSecret: parsed.JWT_SECRET,
    accessTokenTtlSeconds: parsed.ACCESS_TOKEN_TTL_SECONDS,
    refreshTokenTtlSeconds: parsed.REFRESH_TOKEN_TTL_SECONDS,
    bcryptCost: parsed.BCRYPT_COST,
    logLevel: parsed.LOG_LEVEL,
    redisUrl: parsed.REDIS_URL,
    oauthStateTtlSeconds: parsed.OAUTH_STATE_TTL_SECONDS,
    googleClientId: parsed.GOOGLE_CLIENT_ID,
    googleClientSecret: parsed.GOOGLE_CLIENT_SECRET,
    googleRedirectUri: parsed.GOOGLE_REDIRECT_URI,
  };
}
