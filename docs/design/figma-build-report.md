# Logalot — Figma Build Report (#19)

**Status:** Complete · **Date:** 2026-06-27 · **Author:** ux-designer agent

This documents the full design system + app screens authored directly in Figma via the Figma
MCP write tools, and the contract for keeping code in sync (tokens + Code Connect).

Authored from the source-of-truth chain: `packages/design-tokens/tokens.json` (W3C DTCG) ⇄ Figma ⇄
`docs/design/design-system.md`. Dark theme is the default; light is a token-mode override.

---

## 1. Files used (the user's existing files — no new files created)

| Purpose | File key | URL |
|---|---|---|
| **Design System** (foundations + components) | `9N3v2ZGGo3McfSxOLfBPnC` | https://www.figma.com/design/9N3v2ZGGo3McfSxOLfBPnC/Design-System |
| **App Screens** (3 screens × 3 breakpoints) | `bgxzUUUNlz149nkYYjh67x` | https://www.figma.com/design/bgxzUUUNlz149nkYYjh67x/desktop-tablet-mobile |

The stray file `UnSNz4q7hokc0ZEaabyHWW` (a prior mistake) was **not** touched.

**Access probe:** `whoami` → Blaine Richardson, **Full** seat, pro tier
(`team::1024998314493557914`). A read probe + every subsequent `use_figma` write succeeded — the
build was authored **directly** (not returned as a spec).

---

## 2. Foundations (Design System file) — Figma variables & styles

Layered token architecture, names use `_` where DTCG uses `.` (Figma forbids `.`):

| Collection | Modes | Count | Notes |
|---|---|---|---|
| **Primitives** | `Value` | **131** | color ramps (56: neutral/brand/cyan/emerald/amber/red/violet), `font/family·size·weight·lineHeight·letterSpacing`, `space/*` (incl. `0_5`,`1_5`,`2_5`), `radius/*`, `borderWidth/*`, `zIndex/*`, `duration/*`, `easing/*`, `breakpoint/*`. Scopes `[]`/specific; WEB code syntax on all. |
| **Semantic** | `Dark` (default) + `Light` | **45** | `color/bg·fg·border·brand·status` + the first-class **severity** palette `severity/<trace·debug·info·warn·error·fatal>/<fg·bg·border>`. Each aliases a primitive or carries the literal hex8 alpha tint. Scopes: fills/text/stroke as appropriate. |
| **Aliases** | `Value` | **11** | `radius/{control,input,card,panel,pill}` + `size/{control,icon}/{sm,md,lg}` → alias primitives. Scopes `CORNER_RADIUS`/`WIDTH_HEIGHT`, WEB code syntax `var(--radius-control)` etc. |

**Total variables: 187.**

**Text styles (12):** `type/{display, headingLg, headingMd, headingSm, body, bodySm, label,
caption, button, code, logLine, logMeta}` — sans = **Inter**, mono = **JetBrains Mono**
(`code/logLine/logMeta`).

**Effect styles (8):** `elevation/{dark,light}/{sm,md,lg,xl}` (shadows can't be variables; consumers
pick the set matching the active theme).

All component fills/strokes/text bind to **semantic** variables — no hardcoded hex in components.

---

## 3. Component library (Design System file) — 35 components across 6 pages

Page structure: `Cover` · `Foundations` · `——— COMPONENTS ———` · `Controls` · `Data & Logs` ·
`Search & Filter` · `Navigation & Shell` · `Overlays & Feedback` · `Forms`.

Each maps to a **shadcn/ui-on-Base-UI** primitive so the React build gets a11y for free.

| Page | Component (node-id) — variants/states | Base UI primitive |
|---|---|---|
| **Controls** | Button `11:67` (primary/secondary/ghost/danger/link × default/hover/focus/active/disabled/loading); Button/Size `12:17` (sm/md/lg); IconButton `12:58`; Input `13:22` (default/focus/invalid/disabled); Textarea `13:27`; Select `13:40`; Checkbox `14:10`; Radio `14:15`; Switch `14:22`; Badge `15:20` (neutral/brand/status/outline); **LogLevelBadge `15:45`** (6 levels × badge/dot) | Button (native), Input/Textarea (native), Select, Checkbox, Radio (RadioGroup), Switch |
| **Data & Logs** | **LogRow `16:53`** (default/hover/selected/expanded); Card `17:6`; EmptyState `17:9`; Skeleton `17:21` (text/row/panel/circle); DashboardPanel `20:170` (default/loading/empty); **LogTable `32:123`** (sticky header + rows); **LiveTailPanel `32:277`** (play/pause, live/following pills, throughput, dropped-events gap marker) | Collapsible (row expand), native table |
| **Search & Filter** | **SearchBar `22:30`** (default/focus/error); Pagination `22:31` (keyset Load newer/older); TimeRangePicker Trigger `23:7` + Popover `23:14`; **FacetFilter `24:7`** | Popover, Checkbox |
| **Navigation & Shell** | NavItem `26:40` (default/hover/active/collapsed); Tabs `26:41`; TenantSwitcher Trigger `27:15` + Menu `27:21`; Sidebar `27:41`; TopBar `27:69` | Tabs, Combobox/Menu |
| **Overlays & Feedback** | Dialog `30:183` (+ scrim demo `30:182`); Drawer `30:194`; Toast `31:242` (success/warning/danger/info); Tooltip `31:243` | Dialog, Dialog (side), Toast, Tooltip |
| **Forms** | Field `32:276` (default/error wrapper); **AlertRuleForm `32:349`** (name/query/condition/severity/channels/enabled + "would have fired N×" preview) | Field + composed primitives |

⭐ Log-platform-specific (designed first): LogLevelBadge, LogRow, LogTable, LiveTailPanel,
SearchBar, TimeRangePicker, FacetFilter, TenantSwitcher, AlertRuleForm, DashboardPanel.

`AppShell` (spec #20) is realised as `TopBar` + `Sidebar` composed by the app-screen frames.

---

## 4. App screens (App Screens file) — 9 frames (3 screens × desktop/tablet/mobile) + States

All frames bind to the **local** copies of the DS variable collections (Primitives/Semantic/Aliases
exist in this file), so screens are token-driven (no ad-hoc hex). Consolidated onto a single page
**`App Screens — Desktop · Tablet · Mobile`** as a 3×3 matrix (rows = screen, columns = breakpoint).
A tenth frame **`States — Empty & Loading`** (`18:180`) — EmptyState card + loading skeleton log
list — completes the empty/loading-state pass.

| Screen | Desktop 1440 | Tablet 834 | Mobile 390 |
|---|---|---|---|
| **Explore · Live Tail** | `8:2` — 3-pane: facet rail │ live-tail panel (severity rows + dropped-events marker) │ log-detail | `15:2` — icon-rail sidebar, facet toggle, full-width tail | `15:81` — hamburger, condensed level-dot rows, follow FAB |
| **Search** | `12:161` — full SearchBar + time range + active-filter chips + Results/Aggregations tabs + results table + keyset pagination | `16:193` — icon rail, Filters·3 toggle, condensed table, Load older | `16:278` — stacked SearchBar + filter button row + condensed rows |
| **Alerts · Admin** | `13:2` — rules table (name/query/severity/enabled switch/last-fired) + tabs + AlertRuleForm drawer | `17:2` — icon rail, dropped low-priority columns | `17:95` — segmented tabs + stacked rule cards |
| **States** | `18:180` — EmptyState ("No logs match your filters" + Clear filters) and loading skeleton list | — | — |

Responsive rules followed: sidebar 240px → 64px icon-rail → hamburger; rails collapse to
toggles/drawers first; tables → stacked cards on mobile; log text never below `logLine` (12px);
touch targets ≥ 40px on mobile.

---

## 5. Tokens ⇄ Figma sync

`packages/design-tokens/tokens.json` (252 tokens, W3C DTCG) is the **source**; the Figma variables
were authored from it. Every Figma variable added (font families/weights/line-heights/letter-spacing,
duration, easing, breakpoints, semantic radius/size aliases) already exists in `tokens.json` — so
there is **no drift** and no re-extraction was required. The two are in sync. Re-extraction should
be run whenever a designer edits variables in Figma going forward.

---

## 6. Code Connect plan (#24)

The React component library (#20) is **not built yet**, so Code Connect cannot publish real
examples. Convention chosen for when it lands:

- **Primitives (shadcn/ui-on-Base-UI):** `apps/web/src/components/ui/<component>.tsx`
  (e.g. `button.tsx`, `input.tsx`, `select.tsx`, `checkbox.tsx`, `switch.tsx`, `dialog.tsx`,
  `drawer.tsx`, `toast.tsx`, `tooltip.tsx`, `tabs.tsx`, `badge.tsx`, `card.tsx`, `skeleton.tsx`).
- **Log-platform components:** `apps/web/src/components/logalot/<component>.tsx`
  (e.g. `log-level-badge.tsx`, `log-row.tsx`, `log-table.tsx`, `live-tail-panel.tsx`,
  `search-bar.tsx`, `time-range-picker.tsx`, `facet-filter.tsx`, `tenant-switcher.tsx`,
  `alert-rule-form.tsx`, `dashboard-panel.tsx`, `app-shell.tsx`, `sidebar.tsx`, `top-bar.tsx`).
- WEB variable code syntax is already set on all variables (`var(--…)`), so Dev Mode resolves
  tokens correctly today.

**Node-id → intended source path** (publish `*.figma.tsx` for each once #20 exists):

```
11:67  Button         → apps/web/src/components/ui/button.tsx
12:58  IconButton     → apps/web/src/components/ui/icon-button.tsx
13:22  Input          → apps/web/src/components/ui/input.tsx
13:27  Textarea       → apps/web/src/components/ui/textarea.tsx
13:40  Select         → apps/web/src/components/ui/select.tsx
14:10  Checkbox       → apps/web/src/components/ui/checkbox.tsx
14:15  Radio          → apps/web/src/components/ui/radio-group.tsx
14:22  Switch         → apps/web/src/components/ui/switch.tsx
15:20  Badge          → apps/web/src/components/ui/badge.tsx
17:6   Card           → apps/web/src/components/ui/card.tsx
17:9   EmptyState     → apps/web/src/components/ui/empty-state.tsx
17:21  Skeleton       → apps/web/src/components/ui/skeleton.tsx
22:31  Pagination     → apps/web/src/components/ui/pagination.tsx
26:41  Tabs           → apps/web/src/components/ui/tabs.tsx
30:183 Dialog         → apps/web/src/components/ui/dialog.tsx
30:194 Drawer         → apps/web/src/components/ui/drawer.tsx
31:242 Toast          → apps/web/src/components/ui/toast.tsx
31:243 Tooltip        → apps/web/src/components/ui/tooltip.tsx
32:276 Field          → apps/web/src/components/ui/field.tsx
15:45  LogLevelBadge  → apps/web/src/components/logalot/log-level-badge.tsx
16:53  LogRow         → apps/web/src/components/logalot/log-row.tsx
32:123 LogTable       → apps/web/src/components/logalot/log-table.tsx
32:277 LiveTailPanel  → apps/web/src/components/logalot/live-tail-panel.tsx
22:30  SearchBar      → apps/web/src/components/logalot/search-bar.tsx
23:7   TimeRangePicker→ apps/web/src/components/logalot/time-range-picker.tsx
24:7   FacetFilter    → apps/web/src/components/logalot/facet-filter.tsx
20:170 DashboardPanel → apps/web/src/components/logalot/dashboard-panel.tsx
27:15  TenantSwitcher → apps/web/src/components/logalot/tenant-switcher.tsx
27:41  Sidebar        → apps/web/src/components/logalot/sidebar.tsx
27:69  TopBar         → apps/web/src/components/logalot/top-bar.tsx
32:349 AlertRuleForm  → apps/web/src/components/logalot/alert-rule-form.tsx
```

---

## 7. Deferred / follow-ups

- **Code Connect publish** — blocked on #20 (React lib). Mapping plan above is ready to execute.
- **Publish DS as a Figma library** — the DS components are not yet published to the team library,
  so the app-screen frames replicate component structures bound to the local variable copies rather
  than instancing remote DS components. After a one-time **Publish** in the Figma UI, screens can be
  rebuilt from true library instances and `importComponentByKeyAsync`.
- **Light-mode visual QA** — components bind to the `Light` semantic mode but were validated
  primarily in `Dark` (the default); a light-mode review pass is recommended.
