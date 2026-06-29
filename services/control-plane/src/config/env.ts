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
  // Google OIDC (issue #95). All three are required when the authorize endpoint is
  // exercised; they are optional at startup so tests that don't hit that path don't
  // need to provide them. Validated eagerly only when the route is invoked.
  GOOGLE_OIDC_CLIENT_ID: z.string().optional(),
  // Server-side redirect URI registered in the Google Cloud Console. FIXED — never
  // derived from the request (ADR-0007: open-redirect prevention).
  GOOGLE_OIDC_REDIRECT_URI: z.string().url().optional(),
  // Override the authorization endpoint for local testing/mocking.
  GOOGLE_OIDC_AUTH_ENDPOINT: z
    .string()
    .url()
    .default('https://accounts.google.com/o/oauth2/v2/auth'),
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
  /** Google OIDC client ID (required when the authorize endpoint is invoked). */
  googleOidcClientId: string | undefined;
  /** Server-side redirect URI registered in Google Cloud Console (required when the authorize endpoint is invoked). */
  googleOidcRedirectUri: string | undefined;
  /** Google OIDC authorization endpoint URL (defaults to accounts.google.com). */
  googleOidcAuthEndpoint: string;
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
    googleOidcClientId: parsed.GOOGLE_OIDC_CLIENT_ID,
    googleOidcRedirectUri: parsed.GOOGLE_OIDC_REDIRECT_URI,
    googleOidcAuthEndpoint: parsed.GOOGLE_OIDC_AUTH_ENDPOINT,
  };
}
