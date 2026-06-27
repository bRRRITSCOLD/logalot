# @logalot/design-tokens

Single source of truth for Logalot's visual language. `tokens.json` is authored in
[W3C Design Tokens Community Group (DTCG)](https://tr.designtokens.org/format/) format and is the
**code-side mirror of the Figma "Design-System" file**. Figma is the design source of truth; this
file is the contract the frontend (`apps/web`, issue #20) consumes. They are kept in sync
deliberately (re-extract on Figma change; see issue #24 / Code Connect).

**Dark theme is the default** — this is a log viewer.

## Layering

Three layers, strictly one-directional (`primitive ← semantic ← components`). No component ever
reads a primitive directly.

| Layer | Group(s) in `tokens.json` | Purpose | Themed? |
|---|---|---|---|
| **Primitive** | `primitive.*` | Raw, theme-agnostic values: full color scales, font sizes/weights, the 4px spacing grid, radii, z-index, motion, breakpoints. The only place a literal `#hex` or `px` number lives. | No |
| **Semantic** | `semantic.*`, `typography.*` | Intent-named aliases that point at primitives: `bg.surface`, `fg.muted`, `severity.error.fg`, `brand.solid`, control heights, composite type styles. This is what components consume. | Color + elevation only |
| **Theme** | `semantic.color.dark`, `semantic.color.light`, `semantic.elevation.dark/light` | The two theme sets. Same key shape; only the values differ. Dark is canonical; light is an override. | — |

Why color/elevation are themed but spacing/radii/type are not: a button is `32px` tall and has
`radius.control` in both themes — only its colors and shadows flip. Duplicating dimensions across
themes would violate DRY for zero benefit (KISS/YAGNI).

### DRY notes (deliberate decisions)
- **One value, one home.** Every opaque color is an alias (`{primitive.color.brand.600}`), so a
  palette change happens in exactly one place.
- **Alpha tints are literal hex8.** Badge/overlay/hover fills (e.g. `severity.error.bg` =
  `#ef444424`) are written as literal `#rrggbbaa` because DTCG aliases cannot apply opacity to a
  referenced color. The base hue still lives once in `primitive.color.*`; the tint is a documented,
  intentional exception, not a second source of truth.
- **Status reuses severity hues.** `status.success` → emerald, `status.danger` → red, etc. No new
  primitives invented for status.
- **Brand ≠ any severity hue.** Brand is indigo specifically so an interactive accent never reads
  as a log level.

## Log-severity palette (first-class)

Logs have six levels, each with `fg` (text/icon), `bg` (subtle badge fill), and `border`, in both
themes. Hue ramp runs cool→warm with severity:

| Level | Hue | Dark `fg` | Light `fg` |
|---|---|---|---|
| `trace` | slate / neutral | `neutral.400` | `neutral.600` |
| `debug` | cyan | `cyan.300` | `cyan.700` |
| `info` | emerald | `emerald.300` | `emerald.700` |
| `warn` | amber | `amber.300` | `amber.700` |
| `error` | red | `red.400` | `red.700` |
| `fatal` | violet | `violet.300` | `violet.700` |

`bg`/`border` are alpha tints of the same hue (~14%/30% on dark, ~12%/25% on light) so a
`LogLevelBadge` is one component parameterized by level, and a `LogRow` can left-accent-border by
level with no per-level CSS.

## Consuming in the frontend (Tailwind + cva)

The DTCG file is not consumed at runtime; a build step flattens it into CSS variables + a Tailwind
theme. Recommended pipeline for #20 (Style Dictionary v4, which speaks DTCG natively):

1. **Emit two CSS-variable sheets** from the theme sets:
   - `semantic.color.dark` + `semantic.elevation.dark` → `:root` (default).
   - `semantic.color.light` + `semantic.elevation.light` → `:root[data-theme="light"]`.
   - Theme-agnostic tokens (`primitive.*` scales used directly, `semantic.radius/size`,
     `typography.*`) emit once.
   - Token path → CSS var: `semantic.color.dark.bg.surface` → `--color-bg-surface`,
     `severity.error.fg` → `--color-severity-error-fg`, `semantic.radius.card` → `--radius-card`.
2. **Map the CSS vars into `tailwind.config` `theme.extend`** so utilities resolve to vars (and
   therefore flip with the theme automatically):

   ```ts
   // tailwind.config.ts (illustrative)
   theme: {
     extend: {
       colors: {
         bg: { base: 'var(--color-bg-base)', surface: 'var(--color-bg-surface)', /* ... */ },
         fg: { DEFAULT: 'var(--color-fg-default)', muted: 'var(--color-fg-muted)' },
         severity: {
           error: { fg: 'var(--color-severity-error-fg)', bg: 'var(--color-severity-error-bg)' },
           // ...trace/debug/info/warn/fatal
         },
       },
       borderRadius: { control: 'var(--radius-control)', card: 'var(--radius-card)' },
       fontFamily: { mono: 'var(--font-mono)', sans: 'var(--font-sans)' },
       boxShadow: { sm: 'var(--elevation-sm)', md: 'var(--elevation-md)' },
       screens: { sm: '640px', md: '768px', lg: '1024px', xl: '1280px', '2xl': '1536px' },
     },
   }
   ```
3. **cva variants reference the Tailwind names**, never raw values. The semantic layer maps 1:1 to
   cva variant axes:

   ```ts
   // Button: variant ↔ semantic.color.*.brand / status, size ↔ semantic.size.control
   const button = cva('inline-flex items-center rounded-control font-medium', {
     variants: {
       variant: {
         primary: 'bg-brand-solid text-fg-onBrand hover:bg-brand-solidHover',
         ghost:   'text-fg-default hover:bg-bg-hover',
         danger:  'bg-status-danger text-fg-onBrand',
       },
       size: { sm: 'h-7 px-2.5 text-sm', md: 'h-8 px-3', lg: 'h-10 px-4 text-md' },
     },
   });

   // LogLevelBadge: one variant axis = the six severity tokens
   const badge = cva('rounded-pill border px-1.5 font-mono text-2xs uppercase', {
     variants: {
       level: {
         trace: 'text-severity-trace-fg bg-severity-trace-bg border-severity-trace-border',
         error: 'text-severity-error-fg bg-severity-error-bg border-severity-error-border',
         // ...debug/info/warn/fatal
       },
     },
   });
   ```

## Regenerating / keeping in sync

- **Edit values here only via the primitive layer** (or the semantic alias mapping). Never hardcode
  a hex in a component.
- After a Figma change, re-extract variables/styles and diff against this file (issue #24). Then
  the frontend re-runs the Style Dictionary build to regenerate CSS vars + Tailwind theme.
- **Validate** the file parses and every alias resolves:

  ```bash
  node packages/design-tokens/validate.mjs
  ```

## Per-brand / white-label themes (future)

Adding a brand = a `tokens.<brand>.json` that overrides only the `semantic.color.*` set (and
optionally `primitive.color.brand` + `primitive.font.family`) on top of this base. Primitives and
the whole structural layer (spacing/radii/type/motion) are inherited, never copied. Not built yet
(YAGNI) — the layering above is what makes it a future override, not a fork.
