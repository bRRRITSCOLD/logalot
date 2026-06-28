# @logalot/web

Logalot's admin UI: a **TanStack Start** app that doubles as a **BFF** (backend-for-frontend).
It holds the user session and proxies to the `control-plane` (and later `query-service`) with the
session JWT. Built in issue #20; feature pages (log explorer, search, alerts/admin) land in
#21–#23, and Figma Code Connect in #24.

## Stack

| Concern | Choice |
|---|---|
| App / routing | TanStack Start + TanStack Router (file-based) |
| Language | TypeScript (strict) |
| Styling | Tailwind v4, themed **from** `@logalot/design-tokens` |
| Components | shadcn-style own-the-source, Base UI (`@base-ui-components/react`) primitives, `cva` variants, `cn()` merge |
| Forms | TanStack Form |
| Validation | `zod@4` via shared `@logalot/contracts` |
| Tests | Vitest + Testing Library (jsdom) |
| Lint/format | Biome (root `biome.json`) |

## Commands

```bash
pnpm --filter @logalot/web dev        # dev server on http://localhost:3000 (regenerates tokens first)
pnpm --filter @logalot/web build      # production build (.output/)
pnpm --filter @logalot/web test       # vitest run
pnpm --filter @logalot/web typecheck  # tsc --noEmit
pnpm --filter @logalot/web tokens     # regenerate src/styles/tokens.css from design tokens
biome check apps/web                  # lint + format check
```

Point the BFF at a control-plane with `CONTROL_PLANE_URL` (default `http://localhost:8082`).

## Design tokens → Tailwind (single source of truth)

`scripts/build-tokens.mjs` flattens the W3C DTCG file in `@logalot/design-tokens` into
`src/styles/tokens.css`:

- resolves `{alias.path}` references and DTCG dimension/shadow/fontFamily values to literal CSS;
- emits raw custom properties (`--lg-color-bg-surface`, …) — **dark in `:root`** (the default for a
  log viewer), **light** under `:root[data-theme='light']`;
- emits a Tailwind v4 `@theme inline` block that maps Tailwind tokens (`--color-bg-surface`,
  `--radius-card`, `--shadow-md`, …) to those vars, so utilities like `bg-bg-surface`,
  `text-severity-error-fg`, `rounded-card` resolve to `var(--lg-…)` and **flip with the theme
  automatically**.

`tokens.css` and `src/routeTree.gen.ts` are **generated** (gitignored) and rebuilt on
`predev`/`prebuild`. Never hardcode a hex/px in a component — add or change a token upstream and
re-run `pnpm --filter @logalot/web tokens`.

## Component library (`src/components`)

- `ui/` — primitives: `Button`, `Input`, `TextField` (Base UI `Field` → accessible label/error
  wiring), `Badge`, `LogLevelBadge` (the six-level severity palette as one token-driven component),
  `Card`, `Alert`, `Spinner`. Each exports its `cva` variants for composition (e.g. styling a
  `<Link>` like a button). Public API via `ui/index.ts` — import only what you need.
- `states/` — `LoadingState`, `EmptyState`, `ErrorState`, plus the router-level
  `DefaultCatchBoundary` and `NotFound`.
- `shell/` — `AppShell` (responsive sidebar ↔ mobile drawer nav), `ThemeToggle`.

Accessibility comes from the primitive (focus, ARIA, keyboard) — never hand-rolled.

## Auth & session (this app is the trust boundary for the browser)

**Flow.** `/login` POSTs credentials (validated with the shared `loginRequestSchema`) to the
`loginFn` server function, which calls `control-plane` `POST /v1/auth/login`. On success the BFF
writes the access + refresh tokens into cookies and the browser enters `/app`.

**Token storage — decision & tradeoff.** Tokens live **only in `httpOnly`, `SameSite=Lax`,
`Secure` cookies**, set server-side in `src/server/auth.ts`. They are **never** put in
`localStorage`/`sessionStorage` or any JS-readable place.
- *Why:* `httpOnly` cookies are not readable by JavaScript, so an XSS bug cannot exfiltrate the
  tokens. The browser holds opaque cookies; the BFF attaches the access token as a `Bearer` header
  only on the server when proxying (`src/server/control-plane.ts`).
- *`Secure` flag:* defaults **ON** and is driven by an explicit transport signal, not solely
  `NODE_ENV` (an HTTPS staging box that isn't `NODE_ENV=production` must still get `Secure`).
  `COOKIE_SECURE=true|false` overrides; only plain-http local dev (`NODE_ENV=development`) opts out.
- *Tradeoff:* cookies ride along automatically, which is a CSRF surface. We mitigate with
  `SameSite=Lax` and by using TanStack Start **server functions** (POST RPC) for mutations rather
  than form posts to arbitrary endpoints. CSRF protection is **explicitly pinned** in
  `src/start.ts` (`createCsrfMiddleware` filtered to `handlerType === 'serverFn'`) so it can't be
  silently dropped when #21–#23 add their own start instance. The access token is
  short-lived (control-plane default 15 min) with refresh.

**CSRF middleware is pinned, not implicit.** TanStack Start only adds its `defaultCsrfMiddleware`
while **no** `createStart` instance exists. `src/start.ts` declares an explicit
`createStart({ requestMiddleware: [createCsrfMiddleware({ filter: ctx => ctx.handlerType ===
'serverFn' })] })`, so a cross-site request to a server function is rejected (403) and a future
start instance can't quietly remove that protection. Covered by `src/start.test.ts`.

**Login failures don't enable enumeration.** `loginFn` collapses **every** 4xx upstream result
(bad password, unknown user, unknown/disabled tenant, malformed request) to one generic "Invalid
credentials"; only 5xx/unreachable surfaces a distinct "temporarily unavailable" message. The raw
upstream status/code is logged server-side, never returned to the browser.

**Silent refresh.** `getSession` decodes (does **not** verify) the access token's claims for
expiry/UX routing; if expired and a refresh cookie exists it calls `POST /v1/auth/refresh`, rotates
the cookies, and returns the new session. Cryptographic **verification stays at the control-plane**,
which checks the signature on every proxied call (it holds `JWT_SECRET`; the BFF does not).

**Tenant context is server-derived.** `ClientSession` (`{ userId, tenantId, role }`) comes solely
from the verified token claims — there is no field a client can supply to change its tenant. This
mirrors the control-plane's "tenant from credential, never from request body" rule (ADR-0007). The
client reads it read-only via `useSession()`.

**Route guards fail closed.** The pathless `_authed` route's `beforeLoad` calls `getSession` and
`redirect`s to `/login` when it returns null — on the server during SSR and on the client during
navigation — *before* any protected component renders. Verified: an unauthenticated `GET /app`
returns `307 → /login`.

## Adding a feature page (the pattern #21–#23 follow)

A new authenticated page is a route file under `src/routes/_authed/` plus a nav entry. Routes stay
thin: a loader fetches via the BFF, the component renders the library. Domain logic stays in the
backend services.

1. **Create the route** `src/routes/_authed/<name>.tsx` (it inherits the auth guard automatically):

   ```tsx
   import { alertRuleResponseSchema } from '@logalot/contracts';
   import { createFileRoute, redirect } from '@tanstack/react-router';
   import { createServerFn } from '@tanstack/react-start';
   import { getCookie } from '@tanstack/react-start/server';
   import { z } from 'zod';
   import { ACCESS_COOKIE } from '../../server/session';
   import { cpAuthedFetch } from '../../server/control-plane';
   import { LoadingState, ErrorState, EmptyState } from '../../components/states';

   // Compose the endpoint's response shape from the SHARED contract — never a
   // local redefinition. cpAuthedFetch zod-parses the upstream body against this.
   const alertRuleListSchema = z.array(alertRuleResponseSchema);

   // BFF loader: read the access token server-side, proxy to control-plane/query.
   // Never pass a tenant id — the token carries it. Pass the variable `token`
   // (not a string literal) and the schema; the response is validated for you.
   const loadAlertRules = createServerFn({ method: 'GET' }).handler(async () => {
     const token = getCookie(ACCESS_COOKIE);
     if (!token) throw redirect({ to: '/login' });
     return cpAuthedFetch(token, '/v1/alert-rules', alertRuleListSchema);
   });

   export const Route = createFileRoute('/_authed/alerts')({
     loader: () => loadAlertRules(),
     pendingComponent: () => <LoadingState label="Loading alerts…" />,
     // Show a generic message — never surface `error.message`, which can carry a
     // raw upstream/ControlPlaneError/ZodError detail. Log specifics server-side.
     errorComponent: () => <ErrorState message="Couldn't load alerts. Please try again." />,
     component: AlertsPage,
   });

   function AlertsPage() {
     const data = Route.useLoaderData(); // typed from alertRuleListSchema
     // …render with components from `../../components/ui`, EmptyState when empty.
   }
   ```

2. **Surface it in the nav:** in `src/components/shell/app-shell.tsx → NavLinks`, replace the
   matching `<NavPlaceholder … />` with a real `<Link to="/alerts">`.
3. **Validate I/O with `@logalot/contracts`** — never redefine request/response shapes.
4. **Test it** (Vitest + Testing Library) and keep `biome check` clean.

Conventions: keep route files thin (loader + render), push fetching to `src/server/*`, derive URL
state with `nuqs` (wired in `#21` — `NuqsAdapter` is mounted in `__root.tsx`; use
`useQueryStates` with the `nuqs/adapters/tanstack-router` adapter), forms with TanStack Form +
shared zod schemas.

## Live tail over SSE (the BFF streaming pattern, #21)

The Log Explorer (`/explorer`) streams the authed tenant's logs over Server-Sent Events. Because the
browser's `EventSource` **cannot set `Authorization`/`Accept` headers and must never hold a token**,
the stream goes through a **same-origin BFF route**:

- `src/routes/api/tail.ts` — a server route (`server.handlers.GET`) that delegates to
  `src/server/tail-proxy.ts`. The proxy reads the httpOnly access cookie (silently refreshing via the
  refresh cookie, same rotation as `getSession`), **fails closed to 401** when there is no session,
  opens an upstream SSE connection to query-service `GET /v1/tail` with `Authorization: Bearer …` +
  `Accept: text/event-stream`, and **pipes the upstream stream back unchanged** (`data:` / `event: gap`
  framing preserved). Tenancy is server-derived from the forwarded JWT — no client-supplied tenant id.
  Query-service base URL comes from `QUERY_SERVICE_URL` (default `http://localhost:8081`), server-only.
- `src/features/log-explorer/` — the reusable **explorer surface**: `useLogTail` (the EventSource
  state machine: bounded buffer, coalesced flush, pause/resume, reconnect-with-backoff, gap markers),
  `FilterBar` + `matchesFilters` (client-side service/level/label/text filtering), `LogRow`/`GapRow`/
  `LogList`, and `TailToolbar`. #22 (historical search) composes the same `FilterBar`/`LogList`/`LogRow`
  over its REST results — see `src/features/log-explorer/index.ts`.
- The streamed log-event shape is pinned in `tail-event.ts` (mirrors `kernel.LogEvent`'s json tags);
  there is no shared `@logalot/contracts` log-event DTO yet — lift it there when #22 shares it.

## Historical search (the BFF request/response pattern, #22)

`/explorer` has two modes, selected by a `mode` URL param and a header toggle: the **live tail**
(above) and **historical search** (`mode=search`). Search is the REST sibling of the tail — same
chrome, same `LogRow`/`LogList`, same `kernel.LogEvent` shape — over query-service
`GET /v1/search` (FTS + structured filters + time range + keyset pagination).

- `src/features/log-search/` — the search surface: `SearchBar` (a filter builder mapping to the
  handler's exact params — a **single** `level`, repeated `key=value` `label`s, a `from`/`to`
  range), `useLogSearch` (the page/append state machine: keyset "Load more" via the opaque
  `nextCursor`, with latest-request concurrency guarding), and `LogSearch` which renders results
  through the shared explorer row/list. `search-query.ts` owns the contract mapping
  (`buildSearchParams`) and composes the response schema from the #21 `tailLogEventSchema` — the
  **single source of truth** for the search querystring, reused by the BFF and its tests.
- `src/server/search.ts` — the BFF request/response analogue of `tail-proxy.ts`. `searchUpstream`
  (pure, dependency-injected, unit-tested) reads the httpOnly access token, **fails closed** to a
  401 when there is no session, proxies to query-service with `Authorization: Bearer …`, parses the
  body with the shared contract, and maps a 400 to its (user-safe) validation message and every
  other failure to a generic notice. `searchFn` is the thin `createServerFn` wrapper that redirects
  to `/login` on no/expired session. Tenancy is server-derived from the JWT; `QUERY_SERVICE_URL` is
  server-only and never bundled to the client.
- **Filters are URL-synced via nuqs** (`q`/`service`/`level`/`labels`/`from`/`to`), so a search is
  shareable and a shared link auto-runs on mount. Search keys are chosen to not collide with the
  tail's (`q` vs `text`, `level` vs `levels`, `labels` vs `label`); `service` is intentionally
  shared so that filter carries across a mode switch.
- **Shared log-event schema:** with two consumers (tail, search) both inside `apps/web`,
  `tailLogEventSchema` is **reused in place** rather than lifted to `@logalot/contracts` yet
  (rule-of-three not met). The lift remains mechanical for a future third, cross-package consumer.

## Layout

```
apps/web/
  scripts/build-tokens.mjs     design tokens → src/styles/tokens.css
  src/
    start.ts                   pinned CSRF request middleware (createStart instance)
    routes/                    file-based routes (__root, index, login, _authed/app, _authed/explorer)
    routes/api/tail.ts         same-origin BFF SSE proxy route (#21 live tail)
    components/{ui,states,shell}
    features/log-explorer/     live-tail surface: useLogTail, FilterBar, LogRow/GapRow/LogList, toolbar
    features/log-search/       search surface: SearchBar, useLogSearch, LogSearch (reuses LogRow/List)
    server/                    BFF: auth.ts (server fns), control-plane.ts, session.ts, tail-proxy.ts, search.ts
    hooks/use-session.tsx      read-only session context
    lib/cn.ts                  Tailwind-aware class merge
    styles/app.css             Tailwind entry + generated tokens
```
