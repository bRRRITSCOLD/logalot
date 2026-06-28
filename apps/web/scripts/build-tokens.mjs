// Build step: flatten the W3C DTCG design tokens (@logalot/design-tokens) into a
// single CSS file of custom properties + a Tailwind v4 `@theme inline` mapping.
//
// This is the ONE place tokens.json is translated for the frontend. The output
// (src/styles/tokens.css) is committed so the dev server boots without a build,
// but it is regenerated on `predev`/`prebuild` so code can never silently drift
// from the design source (the whole point of issue #19 -> #20).
//
//   Token path                          -> CSS var (raw)           -> Tailwind token
//   semantic.color.dark.bg.surface      -> --lg-color-bg-surface   -> --color-bg-surface  (bg-bg-surface)
//   semantic.color.dark.severity.error.fg -> --lg-color-severity-error-fg -> text-severity-error-fg
//   semantic.elevation.dark.md          -> --lg-elevation-md        -> --shadow-md        (shadow-md)
//   semantic.radius.card                -> --lg-radius-card         -> --radius-card      (rounded-card)
//
// Theme-agnostic tokens (primitive color scales, radius, size, font family) are
// emitted once. Color + elevation are split: dark in :root (default for a log
// viewer), light under :root[data-theme='light'].

import { writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const require = createRequire(import.meta.url);
const tokens = require('@logalot/design-tokens/tokens.json');
const outFile = resolve(dirname(fileURLToPath(import.meta.url)), '../src/styles/tokens.css');

// ── value resolution ───────────────────────────────────────────────────────
const getByPath = (path) => path.split('.').reduce((o, k) => (o == null ? o : o[k]), tokens);

/** Resolve a $value, following `{alias.path}` references to their literal value. */
function resolve$(value) {
  if (typeof value === 'string') {
    const m = value.match(/^\{(.+)\}$/);
    if (m) {
      const node = getByPath(m[1]);
      if (!node || node.$value === undefined) throw new Error(`unresolved alias: ${value}`);
      return resolve$(node.$value);
    }
  }
  return value;
}

const dim = (v) => `${v.value}${v.unit}`;

/** Format a resolved $value to a CSS string, given its DTCG $type. */
function toCss(value, type) {
  const v = resolve$(value);
  switch (type) {
    case 'dimension':
    case 'duration':
      return dim(v);
    case 'fontFamily':
      return v.map((f) => (/\s/.test(f) ? `'${f}'` : f)).join(', ');
    case 'shadow':
      return `${dim(v.offsetX)} ${dim(v.offsetY)} ${dim(v.blur)} ${dim(v.spread)} ${v.color}`;
    default:
      return String(v); // color hex, number, fontWeight
  }
}

const camelToKebab = (s) => s.replace(/([a-z0-9])([A-Z])/g, '$1-$2').toLowerCase();

/** Walk a token subtree, yielding { name, node } for every leaf ($value) token. */
function* leaves(obj, prefix = []) {
  for (const [key, child] of Object.entries(obj)) {
    if (key.startsWith('$')) continue;
    const path = [...prefix, key];
    if (child && child.$value !== undefined)
      yield { name: path.map(camelToKebab).join('-'), node: child };
    else if (child && typeof child === 'object') yield* leaves(child, path);
  }
}

// ── collect raw custom properties ────────────────────────────────────────────
const agnostic = []; // [varName, cssValue] — emitted once
const dark = [];
const light = [];

// Primitive color scales (theme-agnostic; semantic layer aliases these).
for (const [scale, steps] of Object.entries(tokens.primitive.color)) {
  if (scale.startsWith('$')) continue;
  for (const { name, node } of leaves(steps, [scale])) {
    agnostic.push([`--lg-color-${name}`, toCss(node.$value, 'color')]);
  }
}
// Font families.
agnostic.push(['--lg-font-sans', toCss(tokens.primitive.font.family.sans.$value, 'fontFamily')]);
agnostic.push(['--lg-font-mono', toCss(tokens.primitive.font.family.mono.$value, 'fontFamily')]);
// Semantic radius + size.
for (const { name, node } of leaves(tokens.semantic.radius))
  agnostic.push([`--lg-radius-${name}`, toCss(node.$value, 'dimension')]);
for (const { name, node } of leaves(tokens.semantic.size))
  agnostic.push([`--lg-size-${name}`, toCss(node.$value, 'dimension')]);

// Themed color sets (dark default + light override).
for (const { name, node } of leaves(tokens.semantic.color.dark))
  dark.push([`--lg-color-${name}`, toCss(node.$value, 'color')]);
for (const { name, node } of leaves(tokens.semantic.color.light))
  light.push([`--lg-color-${name}`, toCss(node.$value, 'color')]);
// Themed elevation.
for (const { name, node } of leaves(tokens.semantic.elevation.dark))
  dark.push([`--lg-elevation-${name}`, toCss(node.$value, 'shadow')]);
for (const { name, node } of leaves(tokens.semantic.elevation.light))
  light.push([`--lg-elevation-${name}`, toCss(node.$value, 'shadow')]);

// ── Tailwind v4 @theme inline mapping (token -> raw var) ──────────────────────
// `inline` means utilities embed `var(--lg-…)` directly, so they flip with the
// active theme. Color tokens generate bg-/text-/border-/ring- utilities.
const themeLines = [];
const colorNames = [
  ...agnostic.filter(([k]) => k.startsWith('--lg-color-')),
  ...dark.filter(([k]) => k.startsWith('--lg-color-')),
].map(([k]) => k.replace('--lg-color-', ''));
for (const n of colorNames) themeLines.push(`  --color-${n}: var(--lg-color-${n});`);
for (const [k] of agnostic.filter(([k]) => k.startsWith('--lg-radius-')))
  themeLines.push(`  --radius-${k.replace('--lg-radius-', '')}: var(${k});`);
themeLines.push('  --font-sans: var(--lg-font-sans);');
themeLines.push('  --font-mono: var(--lg-font-mono);');
for (const [k] of dark.filter(([k]) => k.startsWith('--lg-elevation-')))
  themeLines.push(`  --shadow-${k.replace('--lg-elevation-', '')}: var(${k});`);

// ── emit ──────────────────────────────────────────────────────────────────
const block = (rows) => rows.map(([k, v]) => `  ${k}: ${v};`).join('\n');
const out = `/* GENERATED by apps/web/scripts/build-tokens.mjs from @logalot/design-tokens.
   DO NOT EDIT BY HAND. Re-run \`pnpm --filter @logalot/web tokens\` after a token change. */

@theme inline {
${themeLines.join('\n')}
}

:root {
${block(agnostic)}

${block(dark)}
}

:root[data-theme='light'] {
${block(light)}
}
`;

writeFileSync(outFile, out);
console.log(
  `tokens.css written: ${colorNames.length} colors, ${agnostic.length + dark.length + light.length} vars`,
);
