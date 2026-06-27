# Logalot — Design System & Authoring Spec

**Status:** Draft (Phase 4, issue #19) · **Date:** 2026-06-27 · **Owner:** ux-designer

This is the authoring contract. It tells the **Figma author** (the main session, using the Figma
MCP write tools) exactly what to build, and it tells the **frontend engineer** (#20) exactly what
components, variants, states, and tokens to implement. Token names below refer to
`packages/design-tokens/tokens.json`. **Dark theme is the default and primary**; every screen and
component is designed dark-first, with the light theme as a token-set override (no separate
designs).

Source-of-truth chain: Figma "Design-System" file ⇄ `tokens.json` ⇄ `apps/web` (Tailwind + cva).
Code Connect (#24) closes the loop so Dev Mode shows real component code.

---

## 1. Foundations (build these as Figma variables/styles first)

Author these as Figma **variables** with two modes — `Dark` (default) and `Light` — mapped to the
`semantic.color.*` and `semantic.elevation.*` theme sets. Primitives become a hidden "primitives"
variable collection that semantics alias.

- **Color** — see `tokens.json` `primitive.color` (scales) and `semantic.color.{dark,light}`
  (surfaces `bg.*`, text `fg.*`, `border.*`, `brand.*`, `status.*`, `severity.*`).
- **Severity** — six levels (`trace/debug/info/warn/error/fatal`), each `fg/bg/border`, both modes.
  This is the signature palette of the product; build it as a dedicated variable group.
- **Typography** — two families (`mono` for log/code/data, `sans` for chrome). Build the 11
  `typography.*` composites as Figma text styles: `display, headingLg, headingMd, headingSm, body,
  bodySm, label, caption, button, code, logLine, logMeta`.
- **Spacing** — 4px grid (`primitive.space.*`). Use for all auto-layout gaps/padding.
- **Radii** — `semantic.radius.{control,input,card,panel,pill}`.
- **Elevation** — `semantic.elevation.{sm,md,lg,xl}` per mode (shadow styles).
- **Motion** — `primitive.duration.*` + `primitive.easing.*` (document on interactive components).
- **Breakpoints** — `primitive.breakpoint.*`; layout frames at three widths (see §4).

Density note: this is a data-dense tool. Default control height is `size.control.md` (32px), log
text is `logLine` (12px mono / 1.45). Prefer `sm` controls inside toolbars.

---

## 2. Component inventory

Each component lists: **variants**, **sizes**, **states**, and **tokens consumed**. States use the
standard set unless noted: `default · hover · focus-visible · active · disabled · loading`.
Focus-visible is always a 2px `border.focus` ring (offset 2px). Disabled = 40% opacity + no pointer
events. All interactive components animate with `duration.fast` / `easing.standard`.

### Primitives / controls

1. **Button**
   - Variants: `primary` (bg `brand.solid`, text `fg.onBrand`), `secondary` (bg `bg.elevated`,
     border `border.default`), `ghost` (transparent, hover `bg.hover`), `danger` (bg
     `status.danger`), `link` (text `fg.link`).
   - Sizes: `sm/md/lg` → `size.control.*`; padding x `space.2.5/3/4`; text `button`.
   - States: full set; `loading` shows a spinner + keeps width; icon-only variant = square.
   - Tokens: `brand.*`, `status.danger`, `fg.onBrand/default`, `bg.hover/elevated`,
     `border.default/focus`, `radius.control`, `typography.button`, `size.control`, `size.icon`.

2. **IconButton** — square Button (`ghost`/`secondary`), `size.control.*`, `size.icon.*`. Used in
   toolbars, log-row actions, panel headers. Tooltip on hover.

3. **Input** (text) — border `border.default`, bg `bg.surface`, text `body`, placeholder
   `fg.subtle`. States add `invalid` (border `status.danger`). Sizes `sm/md/lg`. Optional
   leading/trailing icon/affix. Tokens: `bg.surface/inset`, `fg.default/subtle`, `border.*`,
   `radius.input`, `size.control`, `typography.body`.

4. **Textarea** — Input with `code` typography option (for raw query/JSON). Auto-grow.

5. **Select / Combobox** — trigger = Input shape; menu = `bg.elevated` + `elevation.md`, item hover
   `bg.hover`, selected `bg.selected`. Multi-select chips reuse Badge. Tokens: `bg.elevated/selected`,
   `elevation.md`, `z-index.dropdown`.

6. **Checkbox / Radio / Switch** — unchecked border `border.strong`; checked bg `brand.solid`,
   check `fg.onBrand`. Switch track `bg.active` → `brand.solid`. Tokens: `brand.*`, `border.strong`,
   `radius.{sm,pill}`.

7. **Badge / Tag** — variants: `neutral` (`bg.elevated`/`fg.muted`), `brand` (`brand.muted`/
   `brand.fg`), `status` (success/warning/danger/info from `status.*`), `outline`. Sizes `sm/md`.
   Optional dismiss (×) and leading dot. Tokens: `status.*`, `brand.muted`, `bg.elevated`,
   `radius.pill`, `typography.caption`.

8. **LogLevelBadge** ⭐ — the signature component. One variant axis = the six levels
   (`trace/debug/info/warn/error/fatal`). Uppercase `logMeta` mono text, `radius.pill`, 1px
   `severity.<level>.border`, bg `severity.<level>.bg`, text `severity.<level>.fg`. Two display
   modes: `badge` (pill) and `dot` (just the colored dot, for dense rows). Tokens: `severity.*`,
   `typography.logMeta`, `radius.pill`.

### Data display

9. **LogRow** ⭐ — single log entry. Layout (desktop, auto-layout horizontal):
   `[level dot/badge] [timestamp · logMeta · fg.muted] [service tag] [message · logLine ·
   fg.default] [→ expand]`. Left 2px accent border = `severity.<level>.border`. States:
   `default`, `hover` (`bg.hover`), `selected` (`bg.selected`), `expanded` (reveals structured
   fields/JSON in `bg.inset`, `code` type, with copy buttons). Wrapping toggle (truncate vs wrap).
   Tokens: `severity.*`, `bg.hover/selected/inset`, `fg.default/muted`, `typography.logLine/logMeta/code`,
   `border.subtle`.

10. **LogTable / VirtualizedLogList** ⭐ — the core surface. Column headers (timestamp, level,
    service, message) optionally toggleable; virtualized rows of **LogRow**; sticky header
    (`z-index.sticky`, bg `bg.surface`). Empty/loading via EmptyState/Skeleton. Optional density
    toggle (comfortable/compact → row padding `space.2`/`space.1`). Tokens: `bg.surface/base`,
    `border.default`, `z-index.sticky`.

11. **LiveTailPanel** ⭐ — VirtualizedLogList in streaming mode. Adds: a header with
    play/pause toggle (IconButton), an auto-scroll/“follow” pill (Badge `brand`), a connection
    indicator (Badge: connecting/live/paused/error using `status.*`), a throughput counter
    (`logMeta`), and an inline `gap` marker row (dashed `border.strong`, `fg.muted`) when the
    server drops events (per ADR-0006 slow-consumer behavior). Tokens: `status.*`, `brand.muted`,
    `border.strong`, `typography.logMeta`.

12. **DashboardPanel** — card containing a title, a saved-query subtitle, and a body (time-series
    line/bar chart or a big count/stat). Chart series colors draw from `status.*` + `severity.*` +
    `brand`. Header has an overflow IconButton (edit/remove/refresh). States: `default`, `loading`
    (Skeleton), `error`, `empty`. Tokens: `bg.surface`, `elevation.sm`, `radius.panel`,
    `severity.*`, `status.*`, `typography.headingSm/caption`.

13. **Card** — generic surface: bg `bg.surface`, border `border.default`, `radius.card`,
    `elevation.sm`, padding `space.4`. Header/body/footer slots.

14. **EmptyState** — centered icon + `headingSm` title + `bodySm` muted description + optional
    primary Button. Used for no-results, no-logs-yet, no-alerts. Tokens: `fg.muted/subtle`,
    `typography.headingSm/bodySm`.

15. **Skeleton** — shimmer placeholder (`bg.elevated` → `bg.hover` pulse, `duration.slower`).
    Variants: `text`, `row` (matches LogRow), `panel`, `circle`.

### Search & filtering

16. **SearchBar** ⭐ — large Input (`lg`) with leading search icon, `code` typography (queries are
    structured), a query-syntax hint affix, a run Button, and an inline parse-error state (border
    `status.danger` + caption message). Recent/saved-query dropdown (`bg.elevated`). Tokens:
    `bg.surface/elevated`, `status.danger`, `typography.code`, `border.focus`.

17. **TimeRangePicker** ⭐ — trigger Button (`secondary`) showing the active range; popover with
    quick presets (last 5m/15m/1h/24h/7d/30d) as a list + an absolute from/to calendar+time.
    Highlights the **30-day hot window** boundary (anything older = cold query, marked with an
    `info` Badge “cold”). Tokens: `bg.elevated`, `elevation.md`, `status.info`, `brand.solid`
    (selected preset), `z-index.popover`.

18. **FacetFilter** ⭐ — collapsible facet groups (service, level, label keys) in the left rail;
    each value is a checkbox row with a count (`logMeta`, `fg.muted`); selected facets surface as
    dismissible Badges in the active-filter bar. Level facet uses LogLevelBadge dots. Tokens:
    `bg.surface`, `border.subtle`, `severity.*`, `typography.label/logMeta`.

19. **Pagination / LoadMore** — keyset pagination (per ADR-0003): “Load older / newer” Buttons +
    a result-count caption; cursor-based, not page numbers. Tokens: `fg.muted`, `typography.caption`.

### Navigation & shell

20. **AppShell** — top bar + left sidebar + content region. Top bar: product mark, global
    SearchBar (compact), TenantSwitcher, theme toggle, user menu (height `size.control.lg`, bg
    `bg.surface`, bottom border `border.default`). Sidebar: primary nav. Content: routed screen.
    Tokens: `bg.base/surface`, `border.default`, `z-index.sticky`.

21. **Sidebar / Nav** — vertical nav items (icon + label): Explore (live tail), Search,
    Dashboards, Alerts, Admin. States: `default`, `hover` (`bg.hover`), `active` (`bg.selected` +
    left `brand.solid` accent + `fg.default`), `collapsed` (icon-only, tablet). Tokens:
    `bg.surface/hover/selected`, `brand.solid`, `fg.muted/default`, `typography.label`.

22. **Tabs** — underline style: active tab `fg.default` + 2px `brand.solid` underline; inactive
    `fg.muted`. Used for screen sub-sections (e.g. Admin → Keys/Users/Retention). Tokens:
    `brand.solid`, `fg.default/muted`, `border.default`.

23. **TenantSwitcher** ⭐ — Combobox in the top bar showing current tenant (avatar/initial +
    name); menu lists tenants the principal can access (RBAC, per ADR-0007), with a search field
    and the active tenant checked. Critical for multi-tenant UX — always visible. Tokens:
    `bg.elevated/selected`, `brand.muted`, `elevation.md`, `typography.label/caption`.

### Overlays & feedback

24. **Dialog / Modal** — scrim `bg.overlay` (`z-index.overlay`), panel `bg.elevated` +
    `elevation.xl` + `radius.panel` (`z-index.modal`). Header/body/footer; footer right-aligned
    Buttons. Sizes `sm/md/lg`. Used for confirm-destructive (revoke key, delete alert), create-key.

25. **Drawer** — right (or bottom, on mobile) sliding panel; same tokens as Dialog. Used for
    LogRow detail on tablet/mobile, and AlertRuleForm on desktop. Enter `duration.normal`/
    `easing.standard`.

26. **Toast** — transient notification, top-right stack (`z-index.toast`). Variants reuse
    `status.*` (success/warning/danger/info) with a leading icon + `bodySm` + optional action +
    dismiss. Auto-dismiss `duration.slower`×N. Tokens: `status.*`, `bg.elevated`, `elevation.lg`.

27. **Tooltip** — `bg.elevated` (or inverse), `caption` text, `elevation.md`, `z-index.tooltip`.

### Forms (composed)

28. **Form fields** (Field wrapper) — `label` + control + help/`caption` + error (`status.danger` +
    caption). Layout: vertical stack `space.1.5`. Wraps Input/Select/Checkbox/etc. Built to pair
    with TanStack Form + zod (per stack). Tokens: `fg.default/muted`, `status.danger`,
    `typography.label/caption`.

29. **AlertRuleForm** ⭐ — composed form (in a Drawer/page): name, the saved/typed query
    (SearchBar+Textarea `code`), condition (threshold/rate Select + operator + value Input + window
    TimeRangePicker), severity (LogLevelBadge-style Select), notification channels (webhook/email
    chips), and an enabled Switch. Live “this would have fired N times in the last 24h” preview
    Card. States include `validating`, `saving`. Tokens: composes Form fields, Select, SearchBar,
    Badge, Switch, Card; `status.*` for the severity/condition accent.

⭐ = log-platform-specific, highest-value, design these first.

---

## 3. Component → screen mapping

| Screen | Primary components |
|---|---|
| **Explore / Live tail** | AppShell, FacetFilter, SearchBar (compact), TimeRangePicker, LiveTailPanel (LogRow, LogLevelBadge), Pagination, EmptyState, Skeleton |
| **Search** | AppShell, SearchBar (full), TimeRangePicker, FacetFilter, LogTable/VirtualizedLogList (LogRow), Pagination, Drawer (row detail), Tabs (results/aggregations) |
| **Dashboards** | AppShell, DashboardPanel (grid), Card, Dialog (add panel), TimeRangePicker, EmptyState |
| **Alerts + Admin** | AppShell, Tabs, Card, Table-of-rules (LogRow-like), AlertRuleForm (Drawer), TenantSwitcher, Dialog (confirm), Badge (status), Form fields, Toast |

---

## 4. Responsive layout (author 3 frames per screen: desktop / tablet / mobile)

Breakpoints: **mobile** `< md (768)`, **tablet** `md–<lg (768–1023)`, **desktop** `≥ lg (1024)`.
Author at representative widths **1440 / 834 / 390**.

### Global shell behavior
- **Desktop (≥1024):** persistent left Sidebar (expanded, ~240px) + top bar; content fills rest.
- **Tablet (768–1023):** Sidebar collapses to icon-rail (~64px); top bar full. Secondary rails
  (facets) become a toggle.
- **Mobile (<768):** Sidebar becomes a hamburger → Drawer; top bar shows mark + search icon +
  tenant. Bottom-safe spacing.

### Explore / Live tail
- **Desktop:** 3-pane — left FacetFilter rail (~260px) │ center LiveTailPanel (fills) │ optional
  right LogRow-detail pane (opens on select, ~380px). Toolbar row on top: SearchBar (compact) +
  TimeRangePicker + pause/follow controls.
- **Tablet:** 2-pane — FacetFilter collapses to a toggle button that overlays as a Drawer; center
  LiveTailPanel full width; row detail opens as a right Drawer.
- **Mobile:** single column — sticky compact toolbar (search icon, time range, pause); full-width
  LiveTailPanel with condensed LogRow (level dot + time + message; service/labels in expand);
  facets + row detail are bottom Drawers. Auto-scroll “follow” FAB.

### Search
- **Desktop:** full-width SearchBar + TimeRangePicker top; left FacetFilter rail (~260px); center
  results LogTable; Tabs above results (Results / Aggregations); row click → right Drawer detail.
- **Tablet:** SearchBar full; facets behind a toggle (Drawer); results full width; detail = Drawer.
- **Mobile:** stacked — SearchBar, then a filter button row (time range + facets count → Drawers),
  then results list (condensed rows); detail = full-screen Drawer. LoadMore at bottom.

### Alerts + Admin
- **Desktop:** Tabs (Alerts │ API Keys │ Users │ Retention). Alerts = rules table (name, query,
  condition, severity Badge, enabled Switch, last-fired) + “New rule” Button → right Drawer
  AlertRuleForm. Admin tabs = Cards + tables + create Dialogs. TenantSwitcher in top bar scopes
  everything.
- **Tablet:** same, tables become horizontally scrollable or drop low-priority columns; AlertRuleForm
  Drawer goes near-full-width.
- **Mobile:** Tabs become a Select/segmented control; tables become stacked Cards (one rule/key per
  card with key fields + actions menu); forms are full-screen Drawers; confirms are Dialogs.

### Responsive rules of thumb (for Figma author + #20)
- Log/data text never shrinks below `logLine` (12px) for legibility; chrome can drop to `caption`.
- Rails (facets, detail) are the first thing to collapse → Drawer as width shrinks.
- Tables → stacked Cards on mobile; never horizontal-scroll the primary log list (virtualized list
  stays single-column, columns are toggled off instead).
- Touch targets ≥ 40px (`size.control.lg`) on mobile even where desktop uses `md`.

---

## 5. Theming & accessibility notes
- **Dark is default.** Build dark first; light is the Figma `Light` mode / `semantic.color.light`
  override. No layout differs between themes — only color/elevation variables.
- Severity colors are distinguishable by **shape + position too** (left accent bar, level
  badge/dot, fixed column) not color alone — color-blind safe.
- Body/log text on its surface meets WCAG AA: `fg.default` on `bg.base/surface/inset` in both
  themes. `fg.muted` is for secondary metadata only (meets AA at the sizes used).
- Focus is always visible (`border.focus` ring); never rely on hover for discoverability.
