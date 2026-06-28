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
`Secure` (in prod) cookies**, set server-side in `src/server/auth.ts`. They are **never** put in
`localStorage`/`sessionStorage` or any JS-readable place.
- *Why:* `httpOnly` cookies are not readable by JavaScript, so an XSS bug cannot exfiltrate the
  tokens. The browser holds opaque cookies; the BFF attaches the access token as a `Bearer` header
  only on the server when proxying (`src/server/control-plane.ts`).
- *Tradeoff:* cookies ride along automatically, which is a CSRF surface. We mitigate with
  `SameSite=Lax` and by using TanStack Start **server functions** (POST RPC with the framework's
  CSRF protection) rather than form posts to arbitrary endpoints; mutations are not simple
  cross-site GETs. The access token is short-lived (control-plane default 15 min) with refresh.

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
   import { createFileRoute } from '@tanstack/react-router';
   import { createServerFn } from '@tanstack/react-start';
   import { getCookie } from '@tanstack/react-start/server';
   import { ACCESS_COOKIE } from '../../server/session';
   import { cpAuthedFetch } from '../../server/control-plane';
   import { LoadingState, ErrorState, EmptyState } from '../../components/states';

   // BFF loader: read the access token server-side, proxy to control-plane/query.
   // Never pass a tenant id — the token carries it.
   const loadAlertRules = createServerFn({ method: 'GET' }).handler(async () => {
     const token = getCookie(ACCESS_COOKIE);
     if (!token) throw new Error('unauthenticated');
     return cpAuthedFetch('<token>', '/v1/alert-rules'); // returns shared-contract shapes
   });

   export const Route = createFileRoute('/_authed/alerts')({
     loader: () => loadAlertRules(),
     pendingComponent: () => <LoadingState label="Loading alerts…" />,
     errorComponent: ({ error }) => <ErrorState message={error.message} />,
     component: AlertsPage,
   });

   function AlertsPage() {
     const data = Route.useLoaderData();
     // …render with components from `../../components/ui`, EmptyState when empty.
   }
   ```

2. **Surface it in the nav:** in `src/components/shell/app-shell.tsx → NavLinks`, replace the
   matching `<NavPlaceholder … />` with a real `<Link to="/alerts">`.
3. **Validate I/O with `@logalot/contracts`** — never redefine request/response shapes.
4. **Test it** (Vitest + Testing Library) and keep `biome check` clean.

Conventions: keep route files thin (loader + render), push fetching to `src/server/*`, derive URL
state with `nuqs` (add it when the first page needs it), forms with TanStack Form + shared zod
schemas.

## Layout

```
apps/web/
  scripts/build-tokens.mjs     design tokens → src/styles/tokens.css
  src/
    routes/                    file-based routes (__root, index, login, _authed, _authed/app)
    components/{ui,states,shell}
    server/                    BFF: auth.ts (server fns), control-plane.ts (client), session.ts (pure)
    hooks/use-session.tsx      read-only session context
    lib/cn.ts                  Tailwind-aware class merge
    styles/app.css             Tailwind entry + generated tokens
```
