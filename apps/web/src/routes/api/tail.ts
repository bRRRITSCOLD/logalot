import { createFileRoute } from '@tanstack/react-router';
import { tailProxy } from '../../server/tail-proxy';

// Same-origin BFF live-tail endpoint. The browser's EventSource connects HERE (it
// cannot set Authorization/Accept headers and must never hold a token); this server
// route reads the httpOnly session cookie, injects the bearer token, opens the
// upstream query-service SSE stream, and pipes it back unchanged. All auth/tenancy
// logic — and its tests — live in `server/tail-proxy.ts`; this file is the thin
// route binding. The handler runs server-side only, so QUERY_SERVICE_URL and the
// token never reach the client bundle.
export const Route = createFileRoute('/api/tail')({
  server: {
    handlers: {
      GET: ({ request }) => tailProxy(request),
    },
  },
});
