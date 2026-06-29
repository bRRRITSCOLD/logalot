import Redis from 'ioredis';

// createRedisClient constructs a single ioredis client from a URL.
// Pass the URL returned by the config (REDIS_URL env var); the caller is
// responsible for calling client.quit() on graceful shutdown.
//
// lazyConnect=true prevents ioredis from attempting the connection during
// construction (which would throw synchronously) — the first command triggers it.
// enableOfflineQueue=false causes commands to fail fast while disconnected
// rather than buffering indefinitely, which is desirable for a short-lived
// CSRF token store.
export function createRedisClient(url: string): Redis {
  return new Redis(url, {
    lazyConnect: true,
    enableOfflineQueue: false,
    // Quiet the default ioredis auto-reconnect noise in test environments;
    // the caller decides retry policy.
    maxRetriesPerRequest: 3,
  });
}
