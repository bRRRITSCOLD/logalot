# Logalot — Token Parity (tokens.json ⇄ Tailwind ⇄ Figma)

**Status:** Active · **Issue:** [#24](https://github.com/bRRRITSCOLD/logalot/issues/24) (interim, alongside `figma-component-map.md`) · **Date:** 2026-06-28

This note documents how design tokens flow from the single source of truth into the running app, and
is honest about the one parity check that is **deferred** (the live Figma-variable diff, gated with
Code Connect on the same licensing/tooling).

---

## 1. Single source of truth

`packages/design-tokens/tokens.json` — **W3C DTCG** format, **252 `$value` leaf tokens** — is the
authoritative origin for every visual value. Nothing else (no CSS, no Tailwind config, no Figma
variable) is allowed to define a raw value; everything downstream is generated from or authored
against this file.

Layers inside `tokens.json` (mirrors the Figma collection architecture in `figma-build-report.md`
§2): `primitive.*` (color ramps, font, space, radius, etc.) → `semantic.color.dark` /
`semantic.color.light` + the first-class `severity.*` palette → semantic `radius`/`size` aliases.

## 2. Flow: tokens.json → CSS vars → Tailwind utilities

The translation happens in exactly **one** place: `apps/web/scripts/build-tokens.mjs`. It is a build
step (wired to `predev` / `prebuild`, and runnable via `pnpm --filter @logalot/web tokens`) that
reads `@logalot/design-tokens/tokens.json` and writes the **generated, git-ignored**
`apps/web/src/styles/tokens.css`. Because it regenerates on every dev/build, code cannot silently
drift from the token source.

```
packages/design-tokens/tokens.json        (W3C DTCG — source of truth)
        │   build-tokens.mjs  (flatten + resolve {aliases}, $type-aware formatting)
        ▼
apps/web/src/styles/tokens.css            (GENERATED — DO NOT EDIT)
        ├─ :root { --lg-color-…; --lg-radius-…; --lg-font-…; }      (dark default + theme-agnostic)
        ├─ :root[data-theme='light'] { --lg-color-…; --lg-elevation-…; }   (light override)
        └─ @theme inline { --color-bg-surface: var(--lg-color-bg-surface); … }  (Tailwind v4 map)
        │   @import "./tokens.css"  (in src/styles/app.css, after @import "tailwindcss")
        ▼
Tailwind v4 utilities                      bg-bg-surface · text-severity-error-fg · rounded-card · shadow-md
        │
        ▼
Components                                 cva()/cn() classes — zero hardcoded hex (e.g. button.tsx,
                                           log-level-badge.tsx bind severity tokens only)
```

Key properties of the pipeline:

- **`@theme inline`** means each Tailwind token embeds `var(--lg-…)` directly, so utilities flip with
  the active theme automatically. Dark lives in `:root`; light under `:root[data-theme='light']`
  (toggled by `ThemeToggle` writing `data-theme` on `<html>`).
- **Alias resolution**: `resolve$()` follows `{alias.path}` references to their literal value, so the
  semantic→primitive aliasing in `tokens.json` collapses to concrete CSS values.
- **`$type`-aware formatting**: dimension/duration → `value+unit`; fontFamily → quoted list; shadow →
  composed CSS shadow; color/number/fontWeight → literal. One translator, no per-token special cases.
- **Theme split**: theme-agnostic tokens (primitive color scales, radius, size, font family) emit
  once; color + elevation emit per theme.

Consumption is confirmed in `apps/web/src/styles/app.css`:
`@import "tailwindcss";` then `@import "./tokens.css";`, with `html, body` reading
`var(--lg-color-bg-base)` / `var(--lg-color-fg-default)` / `var(--lg-font-sans)`.

## 3. Figma parity

Per `figma-build-report.md` §5, the Figma variable collections (Primitives / Semantic dark-light /
severity / aliases — 187 variables + 12 text + 8 effect styles) were **authored from this same
`tokens.json`**. Every variable added in Figma already existed in `tokens.json`, so at build time the
report asserts **"in sync, no drift"** and no re-extraction was required. The design side and the
code side therefore share one origin.

## 4. Limit — deferred live diff (honest scope)

This note does **not** include a freshly-run, line-by-line diff of the *current live Figma variables*
against the current `tokens.json`. A live re-extraction requires the **Figma MCP read tools**
(`get_variable_defs` over the Design System file), which is part of the design-sync workflow that is
**gated alongside Code Connect** (same Org/Enterprise + MCP-availability constraints; see
`figma-component-map.md` §"Why this doc exists"). No live diff has been run here, and none is
fabricated.

**Procedure to run the live parity diff when revisited:**

1. Pull live Figma variables for the DS file (`9N3v2ZGGo3McfSxOLfBPnC`) via the Figma MCP
   `get_variable_defs` tool (per collection / per node).
2. Normalize Figma names back to DTCG paths (Figma uses `_` where DTCG uses `.` — e.g.
   `severity_error_fg` → `semantic.color.dark.severity.error.fg`).
3. Resolve each `tokens.json` leaf with the same `resolve$()` logic `build-tokens.mjs` uses, and
   compare resolved literals to the Figma variable values per mode (Dark / Light / Value).
4. Report any divergence as drift; reconcile by editing **`tokens.json`** (source of truth) and
   re-running `pnpm --filter @logalot/web tokens`, then re-authoring the Figma variable if needed.

Until then, parity rests on the shared-origin guarantee in §3 (both sides built from `tokens.json`)
plus the regenerate-on-build pipeline in §2 (code cannot drift from `tokens.json`).
</content>
