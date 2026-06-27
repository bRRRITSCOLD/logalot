#!/usr/bin/env node
// Validates tokens.json: parses as JSON and checks every DTCG alias ({path}) resolves
// to a real token. Exit non-zero on failure. No dependencies.
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const tokens = JSON.parse(readFileSync(join(here, 'tokens.json'), 'utf8'));

const defined = new Set();
const aliases = [];

function collectAliases(value, from) {
  if (typeof value === 'string') {
    const m = value.match(/^\{(.+)\}$/);
    if (m) aliases.push({ ref: m[1], from });
  } else if (Array.isArray(value)) {
    for (const v of value) collectAliases(v, from);
  } else if (value && typeof value === 'object') {
    for (const k of Object.keys(value)) collectAliases(value[k], from);
  }
}

function walk(node, path) {
  if (!node || typeof node !== 'object') return;
  if (Object.hasOwn(node, '$value')) {
    defined.add(path);
    collectAliases(node.$value, path);
  }
  for (const k of Object.keys(node)) {
    if (k.startsWith('$')) continue;
    walk(node[k], path ? `${path}.${k}` : k);
  }
}

walk(tokens, '');

const unresolved = aliases.filter(({ ref }) => !defined.has(ref));
for (const { ref, from } of unresolved) {
  console.error(`UNRESOLVED ALIAS: {${ref}} referenced from ${from}`);
}

console.log(
  `tokens: ${defined.size}  aliases: ${aliases.length}  unresolved: ${unresolved.length}`,
);
if (unresolved.length > 0) process.exit(1);
console.log('OK: tokens.json valid, all aliases resolve.');
