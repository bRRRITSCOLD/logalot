import rateLimit from '@fastify/rate-limit';
import Fastify, {
  type FastifyError,
  type FastifyInstance,
  type FastifyServerOptions,
} from 'fastify';
import type { Redis } from 'ioredis';
import { DomainError } from '../../domain/errors';
import { type RouteDeps, registerRoutes } from './routes';

// LOG_REDACT_PATHS — the never-log denylist for the default Fastify logger
// (ADR-0007, NFR-5: secrets are never logged). Exported so it can be
// exercised directly against pino in tests without standing up the full
// HTTP stack.
//
//   - Standard auth/session headers.
//   - Cookie (may carry session tokens).
//   - id_token / client_secret / code — OIDC secrets Fastify does not log by
//     default (no request-body logging), stripped here as defence-in-depth
//     in case a future log call ever serialises req.body.
//   - Invite secrets (issue #158, R-INV-12): the plaintext invite token
//     (req.body.inviteToken / req.body.token, and the query-string variant a
//     stray GET handler might one day accept), the one-time inviteUrl a
//     response might echo back, and token_hash — the persisted lookup hash
//     is not secret-equivalent to the plaintext, but it is still excluded
//     so no log sink ever lets an operator correlate a hash back to an
//     active invite. The wildcard (`*.field`) forms catch these fields
//     wherever a future log call nests them, not just under req/res.
export const LOG_REDACT_PATHS: readonly string[] = [
  'req.headers.authorization',
  'req.headers.cookie',
  'req.body.id_token',
  'req.body.client_secret',
  'req.body.code',
  'req.body.token',
  'req.body.inviteToken',
  'req.query.token',
  'req.query.inviteToken',
  'res.body.inviteUrl',
  'res.body.token_hash',
  // Bare top-level forms: covers a log call that passes these fields
  // directly as the merging-object (e.g. `log.info({ token_hash }, msg)`),
  // which fast-redact's `*.field` wildcard does NOT match — `*` requires one
  // level of nesting under some other key.
  'token_hash',
  'inviteToken',
  'inviteUrl',
  // One level of nesting under an arbitrary top-level key.
  '*.token_hash',
  '*.inviteUrl',
  '*.inviteToken',
];

// BuildServerOptions re-exports RouteDeps to keep the server layer thin — all
// route dependencies are threaded through unchanged.
export interface BuildServerOptions extends RouteDeps {
  // Log level for the default redacting logger. Ignored when `logger` is given.
  logLevel?: string;
  // Explicit Fastify logger override (e.g. `false` to silence in tests). When set,
  // the caller is responsible for redaction.
  logger?: FastifyServerOptions['logger'];
  // Optional ioredis client for the per-IP rate-limit store.
  // When absent the plugin uses its default in-memory store, which is fine for
  // single-process dev/test.  In production (multi-replica) always supply a
  // Redis client so per-IP counters are shared across instances.
  redis?: Redis;
  // Per-IP rate-limit ceiling on OIDC routes (authorize + callback).
  // Defaults to 20 req / 60 000 ms.
  oidcRateLimitMax?: number;
  oidcRateLimitWindowMs?: number;
  // How many proxy hops to trust when reading X-Forwarded-For.
  // In production the control-plane runs behind a single Caddy TLS-terminating
  // reverse proxy, so the default of 1 means Fastify reads the real client IP
  // from the leftmost XFF entry added by Caddy.  Pass false in unit tests that
  // inject requests directly (app.inject() uses the loopback address as the key).
  trustProxy?: FastifyServerOptions['trustProxy'];
}

// buildServer assembles the Fastify HTTP adapter: structured logging with secret
// redaction, per-IP rate-limiting on OIDC routes, a domain-aware error handler,
// and all routes.  It does NOT listen — the caller (index.ts) or tests (inject)
// control the lifecycle.
export function buildServer(opts: BuildServerOptions): FastifyInstance {
  const app = Fastify({
    // trustProxy: tell Fastify to read the real client IP from X-Forwarded-For
    // rather than using the TCP connection's socket address.  The control-plane
    // runs behind a single Caddy TLS-terminating reverse proxy (infra/aws/security.tf),
    // so trusting 1 hop is both correct and safe — an attacker cannot inject a
    // spoofed XFF header that Caddy would forward unchallenged.
    //
    // Without trustProxy=1 the per-IP rate-limit keyGenerator (req.ip) resolves
    // to Caddy's loopback/internal address for every client, collapsing all
    // per-IP counters into a single shared bucket and breaking the isolation
    // guarantee of acceptance criterion R6.
    //
    // Callers (tests) may override via opts.trustProxy.
    trustProxy: opts.trustProxy ?? 1,
    // Redact credentials so tokens/passwords never reach the logs — see
    // LOG_REDACT_PATHS above for the full denylist + rationale. Fastify does
    // not log request bodies by default, so passwords/secrets in bodies stay
    // out of the logs even without this list; it's defence-in-depth for any
    // future log call that does serialise req.body/res.body.
    logger: opts.logger ?? {
      level: opts.logLevel ?? 'info',
      redact: {
        paths: [...LOG_REDACT_PATHS],
        remove: true,
      },
    },
  });

  // Central error handler on the root scope — inherited by all child plugin
  // scopes including the rate-limit+routes encapsulation below.
  //
  // Error routing:
  //   1. DomainError — typed error from the application layer; carries its own
  //      HTTP status and machine-readable code.
  //   2. @fastify/rate-limit throws the errorResponseBuilder return value when
  //      the limit is exceeded.  The returned object carries `statusCode: 429`
  //      and `error: 'rate_limit_exceeded'`.  We detect these via the
  //      err.statusCode check and pass through the error code.
  //   3. All other 4xx — surface the message but not internal detail.
  //   4. 5xx — log and return a generic message (never expose internals).
  app.setErrorHandler((err: FastifyError, req, reply) => {
    if (err instanceof DomainError) {
      return reply.code(err.status).send({
        error: err.code,
        message: err.expose ? err.message : 'request failed',
        ...(err.details !== undefined ? { details: err.details } : {}),
      });
    }
    const statusCode = typeof err.statusCode === 'number' ? err.statusCode : 500;
    if (statusCode >= 500) {
      req.log.error({ err }, 'unhandled error');
      return reply.code(500).send({ error: 'internal_error', message: 'internal server error' });
    }
    // For 4xx errors, use the `error` field from the error object when present
    // (e.g. @fastify/rate-limit sets it to 'rate_limit_exceeded').
    const errorCode =
      typeof (err as unknown as { error?: string }).error === 'string'
        ? (err as unknown as { error: string }).error
        : 'request_error';
    return reply.code(statusCode).send({ error: errorCode, message: err.message });
  });

  // ── Per-IP rate limiting + routes ────────────────────────────────────────
  // IMPORTANT: @fastify/rate-limit installs an onRoute hook that fires when
  // routes are added to the same Fastify scope.  For per-route config
  // (config.rateLimit) to be picked up, the plugin MUST be fully initialized
  // before the routes are registered.  We achieve this by wrapping both the
  // plugin registration and the routes inside an encapsulated async plugin
  // (void + anonymous async fn) — Fastify awaits the plugin before processing
  // routes registered inside it.
  //
  // The rate-limit plugin is configured with a very high global default
  // (effectively unlimited on non-OIDC routes) so that only the OIDC
  // authorize/callback routes carry the tight per-IP ceiling (see routes.ts).
  //
  // The plugin hooks into onRequest (before validation and preHandlers) so
  // 429 is returned before any outbound Google call is attempted, satisfying
  // the bad-state / rate-limit spec (R11, R12).
  void app.register(async (instance) => {
    await instance.register(rateLimit, {
      // Very high global default — individual OIDC routes override via
      // config.rateLimit in routes.ts.
      max: 1000,
      timeWindow: 60_000,
      redis: opts.redis,
      // @fastify/rate-limit throws the errorResponseBuilder return value.
      // Including statusCode: 429 lets the setErrorHandler (above) route
      // it correctly — without it the fallback is 500.
      errorResponseBuilder: (_req, context) => ({
        statusCode: 429,
        error: 'rate_limit_exceeded',
        message: `rate limit exceeded — retry after ${context.after}`,
      }),
    });

    registerRoutes(instance, opts);
  });

  return app;
}
