# Logalot — Figma ↔ React Component Map (Code Connect stopgap)

**Status:** Active interim artifact · **Issue:** [#24](https://github.com/bRRRITSCOLD/logalot/issues/24) (OPEN, `blocked`) · **Date:** 2026-06-28

---

## Why this doc exists (read first)

Issue #24 was scoped to publish **Figma Code Connect** mappings (`*.figma.tsx`) so Figma Dev Mode
shows real, copy-pasteable code for each design-system component. That work is **BLOCKED**: Code
Connect *publish* requires a Figma **Organization / Enterprise** plan, and this workspace is on the
**Pro** tier (confirmed via the `whoami` probe in `figma-build-report.md` §1 — "Full seat, pro
tier"). The `figma connect publish` REST path returns a license error on Pro.

So instead of carrying a dead `@figma/code-connect` dependency and an un-runnable publish script,
this document is the **manual stand-in**: a maintained, checked-in table that gives design↔code
traceability *today* with **zero `@figma/code-connect` dependency**. It records, for every
design-system component, the authoritative Figma node-id and the **actual** built React file plus
its real prop/variant API.

Node-ids are sourced from `docs/design/figma-build-report.md` §3/§6 (live-verified during the #19
build). React file paths and prop APIs were re-derived by reading the **post-#20–#23** repo — the
build report's original "intended source path" column was a pre-build guess and is stale (see
§"Reconciliation" below).

### How to keep this doc updated

- **A component's props/variants change** → update that row's *key props/variants* cell from the
  component's `cva` config / prop interface. The cell must reflect real exported props, not intent.
- **A component is renamed or moved** → update the *React file* cell. Mapped rows must always point
  at a file that exists; a quick check is `test -f <path>` for every mapped row.
- **A new DS component gets a React counterpart** → move its row from §3 (not-built) to §2 (mapped)
  and fill in the file + props.
- **A Figma node-id changes** (component re-created in Figma) → update the *node-id* and *Figma URL*
  cells. The URL's `node-id` query uses a **hyphen** (`11-67`), the table's node-id column uses the
  Figma-native **colon** (`11:67`).

### Future: converting this to real Code Connect (once licensed)

When the workspace moves to Org/Enterprise and the #24 block clears:

1. Add `@figma/code-connect` as a dev dependency in `apps/web`.
2. For each **mapped** row, author a `<component>.figma.tsx` next to the component, importing the
   real component and binding its props to the Figma component's properties (the *key props/variants*
   column is the spec for that binding).
3. Publish with `npx figma connect publish` using `FIGMA_ACCESS_TOKEN` from the repo-root `/.env`
   (REST path — works even when the Figma MCP is unreachable from a subagent).
4. Register each mapping via the `add_code_connect_map` tool so Dev Mode resolves it.

This doc then becomes the index of what to author; the `.figma.tsx` files become the source of truth.

---

## 1. Mapping legend

| Column | Meaning |
|---|---|
| **Figma component** | Component name as authored in the Design System file. |
| **node-id** | Figma-native node id (colon form), authoritative from `figma-build-report.md` §3/§6. |
| **Figma URL** | Deep link; `node-id` query uses the hyphen form. |
| **React file** | **Actual** repo-relative path of the built counterpart (verified to exist). |
| **Key props / variants** | Real exported prop API / `cva` variants. |
| **status** | `mapped` = a real built React counterpart exists · `not-built` = Figma component exists, no React counterpart shipped in #20–#23. |

Design System file key: `9N3v2ZGGo3McfSxOLfBPnC`. URL base used in every row:
`https://www.figma.com/design/9N3v2ZGGo3McfSxOLfBPnC/Design-System?node-id=<nodeid-hyphen>`

---

## 2. Mapped components (Figma node → built React file)

| Figma component | node-id | Figma URL | React file (actual) | Key props / variants | status |
|---|---|---|---|---|---|
| Button | `11:67` | [11-67](https://www.figma.com/design/9N3v2ZGGo3McfSxOLfBPnC/Design-System?node-id=11-67) | `apps/web/src/components/ui/button.tsx` | `Button` · `variant`: primary \| secondary \| ghost \| danger \| link · `size`: sm \| md \| lg \| icon · forwards `ButtonHTMLAttributes`; `buttonVariants` cva exported for `<Link>` styling | mapped |
| Button / Size | `12:17` | [12-17](https://www.figma.com/design/9N3v2ZGGo3McfSxOLfBPnC/Design-System?node-id=12-17) | `apps/web/src/components/ui/button.tsx` | Size sub-variant of `Button` (`size`: sm=`h-7` \| md=`h-8` \| lg=`h-10` \| icon=`h-8 w-8`) | mapped |
| Input | `13:22` | [13-22](https://www.figma.com/design/9N3v2ZGGo3McfSxOLfBPnC/Design-System?node-id=13-22) | `apps/web/src/components/ui/input.tsx` | `Input` · native `InputHTMLAttributes`; `aria-invalid` drives the error border (no variant prop) | mapped |
| Select | `13:40` | [13-40](https://www.figma.com/design/9N3v2ZGGo3McfSxOLfBPnC/Design-System?node-id=13-40) | `apps/web/src/components/ui/select.tsx` | `SelectField` · `label` (required), `description?`, `error?`, `options?: SelectOption[]` or `children`; native `<select>` | mapped |
| Checkbox | `14:10` | [14-10](https://www.figma.com/design/9N3v2ZGGo3McfSxOLfBPnC/Design-System?node-id=14-10) | `apps/web/src/components/ui/checkbox.tsx` | `CheckboxField` · `label` (required), `description?`; native `<input type=checkbox>` | mapped |
| Badge | `15:20` | [15-20](https://www.figma.com/design/9N3v2ZGGo3McfSxOLfBPnC/Design-System?node-id=15-20) | `apps/web/src/components/ui/badge.tsx` | `Badge` · `tone`: neutral \| brand \| success \| warning \| danger; `badgeVariants` cva exported | mapped |
| LogLevelBadge | `15:45` | [15-45](https://www.figma.com/design/9N3v2ZGGo3McfSxOLfBPnC/Design-System?node-id=15-45) | `apps/web/src/components/ui/log-level-badge.tsx` | `LogLevelBadge` · `level`: trace \| debug \| info \| warn \| error \| fatal (validated via `logLevelSchema`); `logLevelBadgeVariants` cva exported (reused by filter toggles) | mapped |
| Field | `32:276` | [32-276](https://www.figma.com/design/9N3v2ZGGo3McfSxOLfBPnC/Design-System?node-id=32-276) | `apps/web/src/components/ui/text-field.tsx` | `TextField` · built on Base UI `<Field>`; `label` (required), `description?`, `error?`, `rootClassName?`. The Figma "Field" wrapper = this accessible field; auto-wires `htmlFor`/`aria-invalid`/`aria-describedby` | mapped |
| LogRow | `16:53` | [16-53](https://www.figma.com/design/9N3v2ZGGo3McfSxOLfBPnC/Design-System?node-id=16-53) | `apps/web/src/features/log-explorer/log-row.tsx` | `LogRow` · `event: TailLogEvent`; pure/presentational, per-severity left accent; exports `formatTimestamp`, `GapRow` (dropped-events marker) | mapped |
| Card | `17:6` | [17-6](https://www.figma.com/design/9N3v2ZGGo3McfSxOLfBPnC/Design-System?node-id=17-6) | `apps/web/src/components/ui/card.tsx` | `Card` + `CardHeader`/`CardTitle`/`CardDescription`/`CardContent`/`CardFooter` (composable sub-parts, no monolithic prop bag) | mapped |
| EmptyState | `17:9` | [17-9](https://www.figma.com/design/9N3v2ZGGo3McfSxOLfBPnC/Design-System?node-id=17-9) | `apps/web/src/components/states/empty-state.tsx` | `EmptyState` · `title` (required), `description?`, `action?`, `icon?` | mapped |
| SearchBar | `22:30` | [22-30](https://www.figma.com/design/9N3v2ZGGo3McfSxOLfBPnC/Design-System?node-id=22-30) | `apps/web/src/features/log-search/search-bar.tsx` | `SearchBar` · controlled: `value: SearchFilters`, `onChange`, `onSearch`, `disabled?`. Carries the `from`/`to` time-range inputs + single-`level` chips + repeated `key=value` label filters (maps the REST search contract) | mapped |
| Sidebar | `27:41` | [27-41](https://www.figma.com/design/9N3v2ZGGo3McfSxOLfBPnC/Design-System?node-id=27-41) | `apps/web/src/components/shell/app-shell.tsx` | Realized as the desktop `<aside>` inside `AppShell` (`session`, `onLogout`, `children`). See §"App shell" note. | mapped |
| TopBar | `27:69` | [27-69](https://www.figma.com/design/9N3v2ZGGo3McfSxOLfBPnC/Design-System?node-id=27-69) | `apps/web/src/components/shell/app-shell.tsx` | Realized as the mobile/tablet header (menu button → overlay drawer) inside `AppShell`. See §"App shell" note. | mapped |
| Dialog | `30:183` | [30-183](https://www.figma.com/design/9N3v2ZGGo3McfSxOLfBPnC/Design-System?node-id=30-183) | `apps/web/src/components/ui/dialog.tsx` | `Dialog` (`open`, `onOpenChange`) + `DialogTrigger`/`DialogContent` (`title`, `description?`)/`DialogFooter`/`DialogClose`; built on Base UI `<Dialog>` (focus trap, Esc, scroll lock free). Scrim demo node `30:182` is the same component. | mapped |
| AlertRuleForm | `32:349` | [32-349](https://www.figma.com/design/9N3v2ZGGo3McfSxOLfBPnC/Design-System?node-id=32-349) | `apps/web/src/features/alerts/alert-rule-form.tsx` | `AlertRuleFormDialog` · composes `Dialog` + `TextField`/`SelectField`/`CheckboxField` + `Alert`; uses TanStack Form. Exports pure helpers `assembleAlertRuleBody`, `validateAlertRule`, `valuesFromRule`, `parseLabels` | mapped |

**16 mapped rows** (15 distinct Figma components — Button + Button/Size share `button.tsx`).

### App shell note

Figma models the application chrome as two components — **Sidebar `27:41`** and **TopBar `27:69`**.
The React build composes **both** into one responsive `AppShell`
(`apps/web/src/components/shell/app-shell.tsx`): desktop (`lg+`) renders the persistent sidebar;
tablet/mobile (`<lg`) renders the top bar + an overlay drawer that reuses the same `NavLinks`. So
both Figma nodes map to the single `app-shell.tsx` file. The companion `ThemeToggle`
(`shell/theme-toggle.tsx`) has no dedicated Figma DS node (see §4).

---

## 3. Not-built components (Figma node exists, no React counterpart in #20–#23)

These are **correct data, not gaps to paper over** — the Figma DS is broader than the shipped app
surface. Where a built component covers the same *function* via a different shape, that is noted.

| Figma component | node-id | Figma URL | Notes / nearest built realization | status |
|---|---|---|---|---|
| IconButton | `12:58` | [12-58](https://www.figma.com/design/9N3v2ZGGo3McfSxOLfBPnC/Design-System?node-id=12-58) | No dedicated file; covered in practice by `Button` `size="icon"` (`h-8 w-8`) | not-built |
| Textarea | `13:27` | [13-27](https://www.figma.com/design/9N3v2ZGGo3McfSxOLfBPnC/Design-System?node-id=13-27) | No multi-line control built | not-built |
| Radio | `14:15` | [14-15](https://www.figma.com/design/9N3v2ZGGo3McfSxOLfBPnC/Design-System?node-id=14-15) | No radio/RadioGroup built; single-select handled by `<select>` / level chips | not-built |
| Switch | `14:22` | [14-22](https://www.figma.com/design/9N3v2ZGGo3McfSxOLfBPnC/Design-System?node-id=14-22) | No switch built; boolean flags use `CheckboxField` | not-built |
| Skeleton | `17:21` | [17-21](https://www.figma.com/design/9N3v2ZGGo3McfSxOLfBPnC/Design-System?node-id=17-21) | No shimmer skeleton; loading handled by `LoadingState` + `Spinner` (`components/states/loading-state.tsx`, `components/ui/spinner.tsx`) | not-built |
| DashboardPanel | `20:170` | [20-170](https://www.figma.com/design/9N3v2ZGGo3McfSxOLfBPnC/Design-System?node-id=20-170) | No generic panel; admin/overview use `Card`-based sections | not-built |
| LogTable | `32:123` | [32-123](https://www.figma.com/design/9N3v2ZGGo3McfSxOLfBPnC/Design-System?node-id=32-123) | No sticky-header table component; `LogList` (`features/log-explorer/log-list.tsx`) renders the `LogRow` stream | not-built |
| LiveTailPanel | `32:277` | [32-277](https://www.figma.com/design/9N3v2ZGGo3McfSxOLfBPnC/Design-System?node-id=32-277) | No single panel component; realized as a composition of `LogExplorer` + `TailToolbar` (play/pause, live/status pills) + `LogList` | not-built |
| Pagination | `22:31` | [22-31](https://www.figma.com/design/9N3v2ZGGo3McfSxOLfBPnC/Design-System?node-id=22-31) | No `Pagination` component; keyset paging lives in the `useLogSearch` hook + inline Load newer/older buttons | not-built |
| TimeRangePicker (Trigger) | `23:7` | [23-7](https://www.figma.com/design/9N3v2ZGGo3McfSxOLfBPnC/Design-System?node-id=23-7) | No popover picker; the `from`/`to` range is plain `datetime-local`-style inputs inside `SearchBar` | not-built |
| TimeRangePicker (Popover) | `23:14` | [23-14](https://www.figma.com/design/9N3v2ZGGo3McfSxOLfBPnC/Design-System?node-id=23-14) | Same — no popover built | not-built |
| FacetFilter | `24:7` | [24-7](https://www.figma.com/design/9N3v2ZGGo3McfSxOLfBPnC/Design-System?node-id=24-7) | No checkbox facet list; live-tail filtering is a level-toggle `FilterBar` (`features/log-explorer/filter-bar.tsx`); search uses `SearchBar` level chips | not-built |
| NavItem | `26:40` | [26-40](https://www.figma.com/design/9N3v2ZGGo3McfSxOLfBPnC/Design-System?node-id=26-40) | No standalone nav-item; nav link styling is inline in `AppShell`'s `NavLinks` | not-built |
| Tabs | `26:41` | [26-41](https://www.figma.com/design/9N3v2ZGGo3McfSxOLfBPnC/Design-System?node-id=26-41) | No reusable Tabs primitive; the tail/search **mode-toggle** is an inline `ModeToggle` (Button group in `apps/web/src/routes/_authed/explorer.tsx`) | not-built |
| TenantSwitcher (Trigger) | `27:15` | [27-15](https://www.figma.com/design/9N3v2ZGGo3McfSxOLfBPnC/Design-System?node-id=27-15) | No tenant-switcher menu; tenant is server-derived from session (see `tenant-info-card.tsx` for display only) | not-built |
| TenantSwitcher (Menu) | `27:21` | [27-21](https://www.figma.com/design/9N3v2ZGGo3McfSxOLfBPnC/Design-System?node-id=27-21) | Same — no menu built | not-built |
| Drawer | `30:194` | [30-194](https://www.figma.com/design/9N3v2ZGGo3McfSxOLfBPnC/Design-System?node-id=30-194) | No reusable Drawer; the mobile nav drawer is an inline overlay in `AppShell` | not-built |
| Toast | `31:242` | [31-242](https://www.figma.com/design/9N3v2ZGGo3McfSxOLfBPnC/Design-System?node-id=31-242) | No toast system; transient errors surface via inline `Alert` | not-built |
| Tooltip | `31:243` | [31-243](https://www.figma.com/design/9N3v2ZGGo3McfSxOLfBPnC/Design-System?node-id=31-243) | No tooltip built; affordances use native `title` attributes | not-built |

**19 not-built rows.**

---

## 4. Built components without a 1:1 Figma DS node

For completeness — these shipped in #20–#23 and are token-driven, but do not correspond to a single
named Figma DS component (some are app-screen compositions, some are utilities). Listed so the
inventory is complete; not Code-Connect targets unless a matching Figma component is later authored.

| React file | Export | Nearest Figma relative |
|---|---|---|
| `apps/web/src/components/ui/alert.tsx` | `Alert` (`tone`: info \| success \| warning \| danger) | Toast `31:242` (feedback family) |
| `apps/web/src/components/ui/spinner.tsx` | `Spinner` | Skeleton `17:21` (loading family) |
| `apps/web/src/components/states/loading-state.tsx` | `LoadingState` | States frame `18:180` (App Screens file) |
| `apps/web/src/components/states/error-state.tsx` | `ErrorState`, `DefaultCatchBoundary`, `NotFound` | — |
| `apps/web/src/components/shell/theme-toggle.tsx` | `ThemeToggle` | — (dark/light token-mode utility) |
| `apps/web/src/features/log-explorer/filter-bar.tsx` | `FilterBar` | FacetFilter `24:7` (live-tail filter) |
| `apps/web/src/features/log-explorer/tail-toolbar.tsx` | `TailToolbar` | LiveTailPanel `32:277` controls |
| `apps/web/src/features/log-explorer/log-list.tsx` | `LogList`, `GapRow` | LogTable `32:123` |
| `apps/web/src/features/log-explorer/log-explorer.tsx` | `LogExplorer` | LiveTailPanel `32:277` |
| `apps/web/src/features/log-search/log-search.tsx` | `LogSearch` | Search screen `12:161` (App Screens file) |
| `apps/web/src/features/alerts/alert-state-badge.tsx` | `AlertStateBadge` | Badge `15:20` (status specialization) |
| `apps/web/src/features/alerts/alert-manager.tsx` | `AlertManager` | Alerts screen `13:2` (App Screens file) |
| `apps/web/src/features/admin/*` | `AdminDashboard`, `RetentionCard`, `ApiKeysSection`, `UsersSection`, `TenantInfoCard` | DashboardPanel `20:170`, Admin screen `13:2` |

---

## 5. Token parity (tokens.json ⇄ Tailwind ⇄ Figma)

See `docs/design/token-parity.md` for the full token-flow note and the deferred live-diff procedure.
Summary: `packages/design-tokens/tokens.json` (W3C DTCG, 252 tokens) is the single source of truth;
`apps/web/scripts/build-tokens.mjs` generates `src/styles/tokens.css` (CSS custom properties +
Tailwind v4 `@theme inline` map) consumed via `@import "./tokens.css"` in `src/styles/app.css`. The
same `tokens.json` authored the Figma variables (`figma-build-report.md` §5), so the design tokens
and the code tokens share one origin. A *live* Figma-variable re-extraction/diff is deferred
alongside Code Connect (it needs the Figma MCP read tools).
</content>
</invoke>
