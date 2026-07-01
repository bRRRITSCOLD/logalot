# Implementation Plan — Dashboards Frontend (issue #186)

**Author:** lead-engineer
**Date:** 2026-07-01
**Tracks:** GitHub issue #186 — `frontend: Dashboards page + panel viz (/dashboards route, features/dashboards)`
**Specialist for every task:** `frontend-engineer`
**Backend + design:** DONE. This plan sequences the frontend build only.

---

## 1. Ground truth (verified against the codebase)

### 1.1 Backend contracts already shipped
- **Dashboard CRUD (control-plane):** `services/control-plane/src/adapters/http/routes.ts:453+`
  - `POST /v1/dashboards` (create, `dashboard:create`) · `GET /v1/dashboards` → `{ dashboards: [...] }` (`dashboard:list`) · `GET /v1/dashboards/:id` (`dashboard:read`) · `PATCH /v1/dashboards/:id` (`dashboard:update`) · `DELETE /v1/dashboards/:id` → 204 (`dashboard:delete`).
  - RBAC: **read/list = member; write = tenant_admin** (per the route comment).
- **Shared contracts (already exist):** `packages/contracts/src/dashboard.ts` — `dashboardResponseSchema`, `dashboardLayoutSchema`, `panelSchema` (`{ id, type, title, savedQueryId, viz, grid }`), `panelTypeSchema` (`timeseries | stat | logs` — **UI ships `timeseries` + `stat` only**, per #186 scope), `createDashboardRequestSchema`, `updateDashboardRequestSchema`. Panels live **inline** inside `layout.panels[]` (JSONB, migration 000008) — **there is no panel endpoint; a panel add/edit/remove is a mutation of the layout array followed by a `PATCH /v1/dashboards/:id`.**
- **Saved queries (control-plane):** `GET /v1/saved-queries` → `{ savedQueries: [...] }`; shared contract `packages/contracts/src/savedQuery.ts` (`savedQueryResponseSchema`). Panels reference a saved query **by id** (`panel.savedQueryId`); the panel's saved-query **name** (for the subtitle + picker) comes from this list.
- **Panel data (query-service):** `GET /v1/panel-data` — handler `services/query-service/internal/adapters/httpx/panel.go`, response `services/query-service/internal/app/panel.go`.
  - Query params: `savedQueryId` (**required, uuid**), `from` / `to` (RFC3339; default now-1h / now), `buckets` (default 30, **max 100**), `recentLimit` (default 20, max 100).
  - Response: `{ totalCount: number, buckets: [{ bucketStart: RFC3339, count: number }], recentLogs: LogEvent[] }`.
  - **Buckets are SPARSE** — zero-count buckets are omitted; the client MUST gap-fill to render a continuous series.
  - A cross-tenant `savedQueryId` is invisible under RLS → **404** (render an error/empty panel, not a crash).

### 1.2 The web pattern to mirror (this is the contract every task binds to)
- **BFF = `apps/web/src/server/*.ts` server functions** (`createServerFn`), NOT `routes/api/` (that path is SSE-only — `tail.ts`). The browser never holds a token; each server fn reads the httpOnly `ACCESS_COOKIE`, calls upstream with `Authorization: Bearer`, validates with the **shared zod contract**, and returns an **Outcome** envelope. Fail-closed to `/login` on missing session / upstream 401.
  - Dashboard CRUD relay → mirror `apps/web/src/server/admin.ts` (uses `cpAuthedFetch` / `cpAuthedSend` from `server/control-plane.ts`; `AdminOutcome<T>` + `mapAdminError` + `ensureSession`).
  - Panel-data relay → mirror `apps/web/src/server/search.ts` (talks to **query-service** at `QUERY_SERVICE_URL`, pure `…Upstream(token, params, deps)` core with injectable `fetchImpl` for unit tests, defensive body parsing, typed outcome). **The panel-data response has no shared contract yet** — author its schema in the feature slice, exactly as `search.ts` uses `features/log-search/search-query.ts:searchResponseSchema`.
- **Feature slice layout** (mirror `features/alerts/`, `features/log-search/`, `features/admin/`): colocated component `*.tsx` + `*.test.tsx`, pure helpers in `*.ts` + `*.test.ts`, a public-API barrel `index.ts`. Route stays **thin** (`routes/_authed/*.tsx`): a `loader` calling the server fn, `pendingComponent` / `errorComponent` from `components/states`, and the feature surface wired with the mutation server fns as props + `router.invalidate()` on change (see `routes/_authed/alerts.tsx`).
- **URL state = nuqs `useQueryState`** (see `routes/_authed/explorer.tsx`). Time range on the detail page is URL state.
- **RBAC mirror (display-only):** `useCan()` (`apps/web/src/hooks/use-can.ts`) → `can(role, op)` from `packages/contracts/src/rbac.ts`. **`dashboard:*` operations are NOT in the mirror today** (`UI_OPERATIONS` / `MATRIX`) — they must be added or `useCan('dashboard:create')` will not typecheck. This is a Wave-1 foundation change.
- **UI primitives available** (`apps/web/src/components/ui`): `Card*`, `Dialog*`, `Button`, `Input`, `SelectField`, `TextField`, `Badge`, `Spinner`, `Alert`. `components/states`: `EmptyState`, `LoadingState`, `ErrorState`. **No chart primitive and no TimeRangePicker exist** — both are net-new in this slice.
- **Nav:** `apps/web/src/components/shell/app-shell.tsx` → `NavLinks`. A new page is surfaced by adding one `<Link to="/dashboards">` (+ an icon in `components/shell/icons.tsx`). The typed `<Link>` only compiles once the `/dashboards` route exists, so **the nav link ships in the same PR as the list route** (routeTree regenerates on build).
- **Test convention:** vitest + `@testing-library/react`; RBAC-aware rendering via `apps/web/src/features/test-utils.tsx:renderWithRole(role, ui)`; server modules unit-tested with a stubbed `fetch` (`server/admin.test.ts`, `server/search.test.ts`); pure helpers tested in `.test.ts`.

### 1.3 Routing shape
- List: `apps/web/src/routes/_authed/dashboards/index.tsx` → `/dashboards`.
- Detail: `apps/web/src/routes/_authed/dashboards/$dashboardId.tsx` → `/dashboards/$dashboardId`.
- Folder form (no parent `dashboards.tsx`) avoids an Outlet layout; `routeTree.gen.ts` is gitignored and regenerated on build.

---

## 2. Acceptance criteria (carried from #186)
- `/dashboards` lists the tenant's dashboards; a dashboard renders its panels (timeseries + stat) from real `/v1/dashboards` + `/v1/panel-data` data.
- Create / edit / delete a dashboard, and add / edit / remove a panel, from the UI.
- Nav link wired; every call is tenant-scoped via the session JWT (server-derived, never a client param).
- Vitest coverage per the frontend testing convention.
- Out of scope: panel types beyond `timeseries | stat`; Code Connect (#24).

---

## 3. Cross-cutting technical decisions (make these once, here)
1. **Panels are edited through the dashboard aggregate.** Add/edit/remove-panel = read `dashboard.layout.panels[]`, mutate the array (append / replace-by-`id` / filter-out), then `PATCH /v1/dashboards/:id` with the whole new `layout`. There is no per-panel endpoint. Panel `id` is a client-generated stable string (`newPanelId()`); `grid` gets a sensible default for new panels.
2. **Two Outcome-returning BFF modules, two upstreams.** `server/dashboards.ts` → control-plane (shared contracts). `server/panel-data.ts` → query-service (feature-local response schema). Do not fetch the control-plane and query-service from one module.
3. **Panel-data is fetched per-panel, client-side, keyed by the active time range.** The detail route loader fetches the dashboard (structure) via `loadDashboardFn`; each panel then fetches its own series via `loadPanelDataFn` (a hook), so a slow/failed panel degrades in isolation and a time-range change refetches only panel data, not the dashboard.
4. **Gap-fill lives in the feature, not the server.** `gapFillBuckets(buckets, from, to, n)` densifies the sparse response into a continuous zero-filled series for the chart. Pure + unit-tested.
5. **Barrel (`features/dashboards/index.ts`) is a serialization point.** Leaf/presentational components (viz primitives, TimeRangePicker) are imported by their parent via relative path and are **not** re-exported through the barrel; only route-consumed surfaces are. Every task that edits the barrel carries a `blockedBy` edge to the previous barrel editor (see §6).

---

## 4. File-contention map (drives every `blockedBy`)
| File | Created by | Edited by |
| --- | --- | --- |
| `packages/contracts/src/rbac.ts` (+ `.test.ts`) | T1 | — |
| `apps/web/src/features/dashboards/types.ts` | T2 | — |
| `apps/web/src/features/dashboards/index.ts` (**barrel**) | T2 | T4, T5, T8, T9 |
| `apps/web/src/server/dashboards.ts` (+ `.test.ts`) | T3 | — |
| `apps/web/src/features/dashboards/panel-data.ts` (+ `.test.ts`) | T4 | — |
| `apps/web/src/server/panel-data.ts` (+ `.test.ts`) | T4 | — |
| `apps/web/src/features/dashboards/dashboard-list.tsx` (+ `.test.tsx`) | T5 | — |
| `apps/web/src/routes/_authed/dashboards/index.tsx` | T5 | — |
| `apps/web/src/components/shell/app-shell.tsx` (+ `.test.tsx`) | — | T5 |
| `apps/web/src/components/shell/icons.tsx` | — | T5 |
| `apps/web/src/features/dashboards/timeseries-chart.tsx`, `stat-panel.tsx` (+ tests) | T6 | — |
| `apps/web/src/features/dashboards/time-range-picker.tsx` (+ `.test.tsx`) | T7 | — |
| `apps/web/src/features/dashboards/dashboard-detail.tsx` (+ `.test.tsx`) | T8 | T9 |
| `apps/web/src/features/dashboards/panel-grid.tsx`, `use-panel-data.ts` (+ tests) | T8 | — |
| `apps/web/src/routes/_authed/dashboards/$dashboardId.tsx` | T8 | — |
| `apps/web/src/features/dashboards/panel-dialog.tsx` (+ `.test.tsx`) | T9 | — |

**Barrel chain (serial):** T2 → T4 → T5 → T8 → T9. **`dashboard-detail.tsx` chain:** T8 → T9. All other files are disjoint (parallel-safe) as long as the edges below hold.

---

## 5. Waves

### WAVE 1 — Foundation  ← **FIRST (built in isolation)**
**Why it stands alone:** it adds only shared contracts, two Outcome-returning BFF modules, feature types, and pure helpers — all unit-tested with stubbed `fetch`. It renders nothing, registers no route, and adds no typed `<Link>`, so `main` compiles and stays green with the feature entirely dormant.

#### T1 — Add `dashboard:*` to the UI RBAC mirror
- **Files:** `packages/contracts/src/rbac.ts`, `packages/contracts/src/rbac.test.ts`.
- **Interface:** extend `UI_OPERATIONS` with `dashboard:create | dashboard:read | dashboard:list | dashboard:update | dashboard:delete`; add to `MATRIX` — `tenant_admin`: all five; `member`: `dashboard:read`, `dashboard:list`. Mirror the control-plane authority exactly (read/list = member; write = tenant_admin).
- **Seams:** consumed by `useCan('dashboard:*')` in T5 (create/delete gating) and T9 (dialog gating).
- **Tests:** `can('member','dashboard:list') === true`; `can('member','dashboard:create') === false`; `can('tenant_admin','dashboard:delete') === true`; unknown role fails closed.
- **blockedBy:** none.

#### T2 — Feature-slice scaffold: types + barrel
- **Files:** `apps/web/src/features/dashboards/types.ts`, `apps/web/src/features/dashboards/index.ts`, `apps/web/src/features/dashboards/types.test.ts`.
- **Interface:** re-export the shared contract types (`DashboardResponse`, `Panel`, `PanelType`, `DashboardLayout`, `PanelGrid`) and add client-only types + pure helpers: `UiPanelType = 'timeseries' | 'stat'`, `PanelDraft`, `DashboardDialogState`, `PanelDialogState`; `PANEL_TYPES` const; `newPanelId()`; `defaultGrid()`; `savedQuerySubtitle(panel, savedQueries)` (resolve name by id, fallback to `savedQueryId.slice(0,8)…`). Barrel exports the types + helpers only.
- **Seams:** the public API every later task imports.
- **Tests:** `savedQuerySubtitle` resolves a known id to its name and falls back for an unknown id; `newPanelId()` is unique; `defaultGrid()` shape.
- **blockedBy:** none.

#### T3 — BFF relay: dashboards CRUD + saved-queries list
- **Files:** `apps/web/src/server/dashboards.ts`, `apps/web/src/server/dashboards.test.ts`.
- **Interface:** mirror `server/admin.ts`. Pure upstream fns over a token (`listDashboardsUpstream`, `getDashboardUpstream`, `createDashboardUpstream`, `updateDashboardUpstream`, `deleteDashboardUpstream`, `listSavedQueriesUpstream`) using `cpAuthedFetch`/`cpAuthedSend` + shared `dashboard.ts`/`savedQuery.ts` contracts + local list-envelope schemas (`{ dashboards: [...] }`, `{ savedQueries: [...] }`). Outcome envelope + error mapping (401→unauthorized, 403→forbidden, 4xx→invalid message, 5xx→generic). Server fns: `loadDashboardsFn`, `loadDashboardFn({id})`, `createDashboardFn`, `updateDashboardFn({id,patch})`, `deleteDashboardFn({id})`, `loadSavedQueriesFn`; each `ensureSession` → redirect `/login` on unauthorized.
- **Seams:** control-plane `/v1/dashboards*` + `/v1/saved-queries`; `ACCESS_COOKIE`; tenancy is token-derived (never a param/body field).
- **Tests (stubbed fetch, mirror `admin.test.ts`):** list unwraps the envelope; get/create/update/delete map 401/403/4xx/5xx to the right kinds; no-token fails closed **without touching the network**; response-shape drift (ZodError) → `unavailable`; `loadSavedQueriesFn` unwraps `{ savedQueries }`.
- **blockedBy:** none. *(Parallel-safe with T1, T2 — disjoint files; does not touch the barrel.)*

#### T4 — BFF relay: panel-data + response schema + gap-fill
- **Files:** `apps/web/src/features/dashboards/panel-data.ts`, `apps/web/src/features/dashboards/panel-data.test.ts`, `apps/web/src/server/panel-data.ts`, `apps/web/src/server/panel-data.test.ts`; edits `apps/web/src/features/dashboards/index.ts` (barrel → export the panel-data types/helpers).
- **Interface:**
  - `panel-data.ts` (feature, pure): `panelDataResponseSchema` (`{ totalCount, buckets:[{bucketStart,count}], recentLogs }`), `PanelDataResult`, `PanelDataOutcome`; `buildPanelDataParams({ savedQueryId, from, to, buckets })` (RFC3339 encode, clamp `buckets` to ≤100); `gapFillBuckets(buckets, from, to, n)` → dense zero-filled series.
  - `server/panel-data.ts`: pure `panelDataUpstream(token, params, deps)` (injectable `fetchImpl` + `baseUrl`, `QUERY_SERVICE_URL`, defensive body parse, map 400→user message / 401→session ended / 404→"panel query not found" / 5xx→generic) and `loadPanelDataFn` server fn (validated input, fail-closed to `/login`).
- **Seams:** query-service `GET /v1/panel-data`; `ACCESS_COOKIE`; cross-tenant `savedQueryId` → 404 surfaced as a panel error.
- **Tests:** schema parses a sample payload; `gapFillBuckets` fills zeros between sparse buckets, is time-monotonic, and handles the empty case; `buildPanelDataParams` clamps `buckets` and encodes RFC3339; `panelDataUpstream` maps 401/400/404/5xx like `search.test.ts`; no-token fails closed without network.
- **blockedBy:** **[T2]** (edits the barrel `index.ts` that T2 creates). *(Parallel-safe with T1 and T3 — disjoint; T3 does not touch the barrel.)*

---

### WAVE 2 — List view + navigation
#### T5 — Dashboards list surface + `/dashboards` route + nav link
- **Files:** `apps/web/src/features/dashboards/dashboard-list.tsx` (+ `.test.tsx`), `apps/web/src/routes/_authed/dashboards/index.tsx`, `apps/web/src/components/shell/app-shell.tsx`, `apps/web/src/components/shell/icons.tsx`, `apps/web/src/components/shell/app-shell.test.tsx`; edits `apps/web/src/features/dashboards/index.ts` (barrel → export `DashboardList`).
- **Interface:** `DashboardList({ dashboards, create, remove, onChanged })` — a `Card` grid/list of dashboards (name, description, panel count), each row a `<Link to="/dashboards/$dashboardId">`; "New dashboard" button + create dialog and a delete-confirm dialog, both gated by `useCan('dashboard:create' / 'dashboard:delete')`; `EmptyState` when there are none. Route is thin: `loader: () => loadDashboardsFn()`, states from `components/states`, wires `createDashboardFn`/`deleteDashboardFn` + `router.invalidate()`. Nav: add a `DashboardsIcon` to `icons.tsx` and a `<Link to="/dashboards">` in `NavLinks` (placed after Search / before Alerts per `design-system.md` §21).
- **Seams:** `loadDashboardsFn` (T3), `createDashboardFn`/`deleteDashboardFn` (T3); typed `<Link to="/dashboards">` resolves because the route ships in this PR.
- **Tests:** renders the list; empty → `EmptyState`; `renderWithRole('member', …)` hides New/Delete, `tenant_admin` shows them; create dialog submit calls `create`; delete-confirm calls `remove` then `onChanged`; `app-shell.test.tsx` asserts the Dashboards nav link exists and points to `/dashboards`.
- **blockedBy:** **[T1, T3, T4]** — T1 (dashboard RBAC ops for `useCan`), T3 (list/create/delete relay), T4 (barrel serialization; T4 is the previous barrel editor).

---

### WAVE 3 — Detail, panel grid, and visualizations
#### T6 — Panel viz primitives: `TimeseriesChart` + `StatPanel`
- **Files:** `apps/web/src/features/dashboards/timeseries-chart.tsx` (+ `.test.tsx`), `apps/web/src/features/dashboards/stat-panel.tsx` (+ `.test.tsx`). **No barrel edit** (consumed relatively by the detail/grid in T8).
- **Interface:** `TimeseriesChart({ series })` — inline SVG line/bar over a gap-filled series; `default | loading | empty | error` states; colors from `status.*`/`severity.*`/`brand` tokens. `StatPanel({ value })` — large formatted count with the same state set. Both purely presentational (data passed in; no fetching).
- **Seams:** consumes `PanelDataResult` / `gapFillBuckets` types from `panel-data.ts` (T4).
- **Tests:** `TimeseriesChart` renders N points/bars for a series and shows the empty state for an empty series; `StatPanel` formats a count (e.g. thousands separator) and renders the loading/error states.
- **blockedBy:** **[T4]** (imports panel-data types/helpers). *(Parallel-safe with T5 and T7 — disjoint files, no barrel edit.)*

#### T7 — `TimeRangePicker`
- **Files:** `apps/web/src/features/dashboards/time-range-picker.tsx` (+ `.test.tsx`). **No barrel edit** (consumed relatively by the detail in T8).
- **Interface:** `TimeRangePicker({ value, onChange })` per `design-system.md` §17 — a `secondary` trigger showing the active range; popover with quick presets (5m/15m/1h/24h/7d/30d) + absolute from/to; emits `{ from, to }` as RFC3339. Marks any range older than the 30-day hot window with an `info` "cold" badge.
- **Seams:** its `{from,to}` value is the URL state (nuqs) the detail route feeds to `loadPanelDataFn`.
- **Tests:** selecting a preset emits the expected `{from,to}`; the absolute picker validates `from < to`; a >30-day range shows the "cold" badge.
- **blockedBy:** **[T2]** (types only). *(Parallel-safe with T4/T5/T6.)*

#### T8 — Dashboard detail + panel grid + `/dashboards/$dashboardId` route
- **Files:** `apps/web/src/features/dashboards/dashboard-detail.tsx` (+ `.test.tsx`), `apps/web/src/features/dashboards/panel-grid.tsx` (+ `.test.tsx`), `apps/web/src/features/dashboards/use-panel-data.ts` (+ `.test.ts`), `apps/web/src/routes/_authed/dashboards/$dashboardId.tsx`; edits `apps/web/src/features/dashboards/index.ts` (barrel → export `DashboardDetail`).
- **Interface:** `DashboardDetail({ dashboard, savedQueries, onChanged })` — header (name/description, edit dashboard, `TimeRangePicker` bound to nuqs URL state) + `PanelGrid`. `PanelGrid` lays out `layout.panels[]` on the grid; each panel is a `DashboardPanel` card (title + `savedQuerySubtitle` + overflow menu) whose body picks `TimeseriesChart` (buckets, gap-filled) or `StatPanel` (`totalCount`) by `panel.type`, driven by `use-panel-data.ts` (per-panel fetch via `loadPanelDataFn`, keyed by `savedQueryId` + active `{from,to}`, own loading/error/empty). Route is thin: `loader` → `loadDashboardFn({id})` (+ `loadSavedQueriesFn` for subtitles), states from `components/states`.
- **Seams:** `loadDashboardFn`/`loadSavedQueriesFn` (T3), `loadPanelDataFn` (T4), `TimeseriesChart`/`StatPanel` (T6), `TimeRangePicker` (T7).
- **Tests:** renders a timeseries panel and a stat panel from fixture panel-data; each panel shows its saved-query subtitle; a per-panel fetch error degrades only that panel; changing the time range refetches panel data (mock `loadPanelDataFn` called with the new range); `use-panel-data` maps outcome→state.
- **blockedBy:** **[T5, T6, T7]** — T5 (previous barrel editor + the list route it navigates back to), T6 (viz primitives), T7 (time-range picker). T3/T4 pulled in transitively.

---

### WAVE 4 — Panel authoring
#### T9 — Add / edit / remove-panel dialog + layout PATCH mutations
- **Files:** `apps/web/src/features/dashboards/panel-dialog.tsx` (+ `.test.tsx`); edits `apps/web/src/features/dashboards/dashboard-detail.tsx` (add "Add panel" + per-panel edit/remove controls) and `apps/web/src/features/dashboards/index.ts` (barrel → export dialog if route-consumed).
- **Interface:** `PanelDialog` (add/edit) — form with title, type `SelectField` (`timeseries | stat`), and a saved-query picker (options + subtitle from `loadSavedQueriesFn`), default `grid`. Submit path implements decision §3.1: clone `dashboard.layout.panels[]`, append (add) / replace-by-`id` (edit) / filter-out (remove), then `updateDashboardFn({ id, patch: { layout } })`; `router.invalidate()`/`onChanged` on success. All authoring controls gated by `useCan('dashboard:update')`.
- **Seams:** `loadSavedQueriesFn` (T3), `updateDashboardFn` (T3), `dashboard-detail.tsx` (T8).
- **Tests:** add-panel appends to `layout.panels` and PATCHes the whole layout; edit mutates the panel with the matching `id`; remove filters it out; the picker renders the saved-query name and the panel shows it as the subtitle; `renderWithRole('member', …)` cannot open the dialog / sees no authoring controls; the type toggle switches which viz the preview/panel uses.
- **blockedBy:** **[T8, T3]** — T8 (edits `dashboard-detail.tsx` + previous barrel editor), T3 (saved-queries relay).

---

## 6. Dependency graph (blockedBy)
```
T1 (rbac mirror) ─────────────┐
T2 (scaffold types+barrel) ─┬─→ T4 (panel-data relay+schema) ─┬─→ T6 (viz primitives) ─┐
                            └─────────────────────────→ T7 (TimeRangePicker) ──────────┤
T3 (dashboards CRUD relay) ──┐                                                          │
T1, T3, T4 ──────────────────┴─→ T5 (list + route + nav) ──────────────────────────────┤
                                                        T5, T6, T7 ─→ T8 (detail+grid) ─┴─→ (barrel)
                                                                      T8, T3 ─→ T9 (panel dialog)
```
- **Start in parallel:** T1, T2, T3.
- **Then:** T4 (needs T2). T7 (needs T2) can start early, in parallel with T4/T5. T6 needs T4.
- **Barrel serial chain:** T2 → T4 → T5 → T8 → T9 (every barrel editor blocked on the prior one).
- **`dashboard-detail.tsx` serial:** T8 → T9.

## 7. Wave summary
| Wave | Tasks | Note |
| --- | --- | --- |
| **1 — Foundation (FIRST)** | T1, T2, T3, T4 | Contracts + BFF relays + types + pure helpers. Dormant, unit-tested, `main` green. |
| 2 — List view | T5 | List surface + `/dashboards` route + nav link. |
| 3 — Detail + viz | T6, T7, T8 | Viz primitives + TimeRangePicker (parallel) → detail/grid route. |
| 4 — Panel authoring | T9 | Add/edit/remove-panel via layout PATCH. |
</content>
</invoke>
