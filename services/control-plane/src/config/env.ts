import { z } from 'zod';

// Environment configuration, validated with zod at startup so a misconfigured
// service fails fast and loud rather than at first request. The app DB URL must
// point at the NOSUPERUSER logalot_app role (see pool.ts / migration 000011).
const EnvSchema = z
  .object({
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
    LOG_LEVEL: z
      .enum(['fatal', 'error', 'warn', 'info', 'debug', 'trace', 'silent'])
      .default('info'),
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
    // Per-IP rate limiting on OIDC routes (authorize + callback).
    // Defaults: 20 requests per minute per IP — intentionally conservative since
    // these endpoints trigger outbound Google calls (T02 / R11, R12).
    OIDC_RATE_LIMIT_MAX: z.coerce.number().int().positive().default(20),
    OIDC_RATE_LIMIT_WINDOW_MS: z.coerce.number().int().positive().default(60_000),
    // ── Invite config (epic #140, ADR-0012, R-INV-14) ─────────────────────────
    // INVITE_TTL_SECONDS — how long an invite token remains valid before it
    // must be re-sent (default 7 days). Set shorter in high-security tenants.
    INVITE_TTL_SECONDS: z.coerce
      .number()
      .int()
      .positive()
      .default(60 * 60 * 24 * 7),
    // INVITE_MAX_OUTSTANDING_PER_TENANT — cap on pending invites per tenant
    // (ADR-0012 §Capacity). Prevents abuse without requiring a hard DB limit.
    INVITE_MAX_OUTSTANDING_PER_TENANT: z.coerce.number().int().positive().default(50),
    // INVITE_ACCEPT_BASE_URL — prefix used to build the accept link embedded in
    // invitation emails (e.g. https://app.logalot.io). FIXED here so the HTTP
    // layer never influences the link destination (ADR-0013, R-INV-14).
    INVITE_ACCEPT_BASE_URL: z.string().url().default('http://localhost:5173'),
    // ── Email provider (epic #140, ADR-0013) ──────────────────────────────────
    // EMAIL_PROVIDER — selects the outbound mail adapter handed to Task 12.
    // 'none'  → no-op (safe default; invite link still returned in API response)
    // 'smtp'  → NODEMAILER over SMTP; requires SMTP_* params below
    // 'ses'   → AWS SES v3 SDK (future; reserved)
    // The provider is fixed at startup and never derived from request data
    // (ADR-0013, R-INV-14 — prevents open-relay / SSRF via spoofed provider).
    EMAIL_PROVIDER: z.enum(['none', 'smtp', 'ses']).default('none'),
    // SMTP params — required only when EMAIL_PROVIDER=smtp.
    // Parsed unconditionally; cross-field validation below rejects missing values.
    SMTP_HOST: z.string().optional(),
    SMTP_PORT: z.coerce.number().int().positive().optional(),
    SMTP_USER: z.string().optional(),
    // SMTP_PASS is a secret — read from SSM / env only, never logged.
    SMTP_PASS: z.string().optional(),
    SMTP_FROM: z.string().optional(),
  })
  .superRefine((data, ctx) => {
    if (data.EMAIL_PROVIDER === 'smtp') {
      const required: Array<[keyof typeof data, string]> = [
        ['SMTP_HOST', 'SMTP_HOST'],
        ['SMTP_PORT', 'SMTP_PORT'],
        ['SMTP_FROM', 'SMTP_FROM'],
      ];
      for (const [field, label] of required) {
        if (data[field] === undefined || data[field] === '') {
          ctx.addIssue({
            code: z.ZodIssueCode.custom,
            path: [field],
            message: `${label} is required when EMAIL_PROVIDER=smtp`,
          });
        }
      }
    }
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
  /** Google OIDC client ID (required when the authorize endpoint is invoked). */
  googleOidcClientId: string | undefined;
  /** Server-side redirect URI registered in Google Cloud Console (required when the authorize endpoint is invoked). */
  googleOidcRedirectUri: string | undefined;
  /** Google OIDC authorization endpoint URL (defaults to accounts.google.com). */
  googleOidcAuthEndpoint: string;
  /** Max requests per IP per window on OIDC routes (authorize + callback). */
  oidcRateLimitMax: number;
  /** Rate-limit window size in milliseconds for OIDC routes. */
  oidcRateLimitWindowMs: number;
  // ── Invite config ──────────────────────────────────────────────────────────
  /** How long (seconds) an invite token is valid before expiry. Default: 7 days. */
  inviteTtlSeconds: number;
  /** Maximum number of outstanding (pending) invites per tenant. Default: 50 (ADR-0012). */
  inviteMaxOutstandingPerTenant: number;
  /**
   * Base URL used to construct the invite-accept link in emails. FIXED at startup —
   * never derived from request data (ADR-0013, R-INV-14).
   */
  inviteAcceptBaseUrl: string;
  // ── Email provider ─────────────────────────────────────────────────────────
  /**
   * Selects the outbound mail adapter (ADR-0013, R-INV-14).
   * 'none'  → no-op (invite link is returned in API response only)
   * 'smtp'  → NODEMAILER; requires smtp* fields below
   * 'ses'   → AWS SES v3 SDK (reserved for future use)
   */
  emailProvider: 'none' | 'smtp' | 'ses';
  /** SMTP hostname — required when emailProvider='smtp'. */
  smtpHost: string | undefined;
  /** SMTP port — required when emailProvider='smtp'. */
  smtpPort: number | undefined;
  /** SMTP auth username — optional even for smtp (some relays skip auth). */
  smtpUser: string | undefined;
  /** SMTP auth password — secret; NEVER log. Required for authenticated relays. */
  smtpPass: string | undefined;
  /** Envelope From address for outbound mail. Required when emailProvider='smtp'. */
  smtpFrom: string | undefined;
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
    googleOidcClientId: parsed.GOOGLE_OIDC_CLIENT_ID,
    googleOidcRedirectUri: parsed.GOOGLE_OIDC_REDIRECT_URI,
    googleOidcAuthEndpoint: parsed.GOOGLE_OIDC_AUTH_ENDPOINT,
    oidcRateLimitMax: parsed.OIDC_RATE_LIMIT_MAX,
    oidcRateLimitWindowMs: parsed.OIDC_RATE_LIMIT_WINDOW_MS,
    inviteTtlSeconds: parsed.INVITE_TTL_SECONDS,
    inviteMaxOutstandingPerTenant: parsed.INVITE_MAX_OUTSTANDING_PER_TENANT,
    inviteAcceptBaseUrl: parsed.INVITE_ACCEPT_BASE_URL,
    emailProvider: parsed.EMAIL_PROVIDER,
    smtpHost: parsed.SMTP_HOST,
    smtpPort: parsed.SMTP_PORT,
    smtpUser: parsed.SMTP_USER,
    smtpPass: parsed.SMTP_PASS,
    smtpFrom: parsed.SMTP_FROM,
  };
}
