import Fastify, {
  type FastifyError,
  type FastifyInstance,
  type FastifyServerOptions,
} from 'fastify';
import { DomainError } from '../../domain/errors';
import { type RouteDeps, registerRoutes } from './routes';

// BuildServerOptions re-exports RouteDeps to keep the server layer thin — all
// route dependencies are threaded through unchanged.
export interface BuildServerOptions extends RouteDeps {
  // Log level for the default redacting logger. Ignored when `logger` is given.
  logLevel?: string;
  // Explicit Fastify logger override (e.g. `false` to silence in tests). When set,
  // the caller is responsible for redaction.
  logger?: FastifyServerOptions['logger'];
}

// buildServer assembles the Fastify HTTP adapter: structured logging with secret
// redaction, a domain-aware error handler, and all routes. It does NOT listen —
// the caller (index.ts) or tests (inject) control the lifecycle.
export function buildServer(opts: BuildServerOptions): FastifyInstance {
  const app = Fastify({
    // Redact credentials so tokens/passwords never reach the logs (ADR-0007,
    // NFR-5: secrets are never logged). Fastify does not log request bodies by
    // default, so passwords/secrets in bodies stay out of the logs too.
    logger: opts.logger ?? {
      level: opts.logLevel ?? 'info',
      redact: {
        paths: ['req.headers.authorization', 'req.headers.cookie'],
        remove: true,
      },
    },
  });

  // Central error handler: domain errors carry their HTTP status + machine code;
  // everything else is a 500 with a generic message (details only to the log).
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
    return reply.code(statusCode).send({ error: 'request_error', message: err.message });
  });

  registerRoutes(app, opts);
  return app;
}
