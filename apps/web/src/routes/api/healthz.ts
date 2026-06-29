import { createFileRoute } from '@tanstack/react-router';

// Liveness probe: returns 200 {"status":"ok"} unconditionally.
// Used by Docker HEALTHCHECK and Caddy upstream health checks (R16).
// A more complex readiness check (upstream service pings) is deferred until
// the BFF has typed clients for control-plane and query-service.
export const Route = createFileRoute('/api/healthz')({
  server: {
    handlers: {
      GET: () =>
        new Response(JSON.stringify({ status: 'ok' }), {
          status: 200,
          headers: { 'content-type': 'application/json' },
        }),
    },
  },
});
