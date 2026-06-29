import { buildServer } from './adapters/http/server';
import { createPool } from './adapters/postgres/pool';
import { loadConfig } from './config/env';
import { buildContainer } from './container';

// Composition + lifecycle entrypoint. Loads + validates config, wires the
// container, starts Fastify, and shuts down gracefully (drain HTTP, then close the
// pool) on SIGTERM/SIGINT.
async function main(): Promise<void> {
  const config = loadConfig();
  const pool = createPool(config.databaseUrl);
  const { services, tokenService, shutdown: shutdownContainer } = buildContainer(pool, config);

  const app = buildServer({
    services,
    tokenService,
    ping: async () => {
      await pool.query('SELECT 1');
      return true;
    },
    logLevel: config.logLevel,
  });

  const shutdown = async (signal: string): Promise<void> => {
    app.log.info({ signal }, 'shutting down');
    try {
      await app.close();
      await pool.end();
      await shutdownContainer();
      process.exit(0);
    } catch (err) {
      app.log.error({ err }, 'error during shutdown');
      process.exit(1);
    }
  };
  for (const signal of ['SIGTERM', 'SIGINT'] as const) {
    process.on(signal, () => {
      void shutdown(signal);
    });
  }

  await app.listen({ host: config.host, port: config.port });
}

main().catch((err) => {
  // Startup failure: log to stderr (no logger yet) and exit non-zero.
  console.error('control-plane failed to start', err);
  process.exit(1);
});
