#!/usr/bin/env node
/**
 * Static check for the stylesheet the browser half injects.
 *
 * The CSS lives inside `lib/client.js` as a JavaScript array of strings, so
 * `node --check` sees perfectly valid JavaScript even when the CSS is broken.
 * The failure mode that matters: a rule accidentally nested inside another
 * rule's declaration block makes the parser swallow everything after it, and the
 * page then renders with some elements completely unstyled — no error anywhere.
 *
 * This asserts the three things that catch that:
 *   1. braces balance;
 *   2. no `{` opens while a declaration block is already open;
 *   3. every `dshSessionRewind*` class the component actually uses has a rule.
 *
 * Usage
 *   node scripts/check-stylesheet.mjs
 */

import { readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const CLIENT = join(ROOT, 'lib/client.js');
const PREFIX = 'dshSessionRewind';

const source = readFileSync(CLIENT, 'utf8');

// ---- extract the CSS -------------------------------------------------------
const start = source.indexOf('const SHEET = [');
if (start < 0) {
  console.error('check-stylesheet: no `const SHEET = [` array found in lib/client.js');
  process.exit(1);
}
const endMarker = '].join(';
const end = source.indexOf(endMarker, start);
if (end < 0) {
  console.error('check-stylesheet: the SHEET array is not closed with `].join(`');
  process.exit(1);
}
const arrayLiteral = source.slice(start + 'const SHEET = '.length, end + 1);
let parts;
try {
  // The array only holds string literals, so evaluating it is safe and exact.
  parts = new Function(`return ${arrayLiteral};`)();
} catch (error) {
  console.error(`check-stylesheet: the SHEET array is not evaluable: ${error.message}`);
  process.exit(1);
}
if (!Array.isArray(parts) || parts.some((part) => typeof part !== 'string')) {
  console.error('check-stylesheet: SHEET must be an array of strings');
  process.exit(1);
}
const css = parts.join('\n');

// ---- 1 + 2: brace structure ----------------------------------------------
let depth = 0;
let offset = 0;
const problems = [];
for (const character of css) {
  if (character === '{') {
    if (depth > 0) {
      const line = css.slice(0, offset).split('\n').length;
      problems.push(`nested block opened at line ${line}: a rule was inserted inside another rule`);
    }
    depth += 1;
  } else if (character === '}') {
    depth -= 1;
    if (depth < 0) {
      problems.push('unbalanced "}"');
      depth = 0;
    }
  } else if (character === ';' && depth === 0) {
    const line = css.slice(0, offset).split('\n').length;
    problems.push(`stray ";" outside any block at line ${line}`);
  }
  offset += 1;
}
if (depth !== 0) problems.push(`unbalanced braces: ${depth} block(s) left open`);

// ---- 3: every used class has a rule --------------------------------------
const used = new Set();
for (const match of source.matchAll(new RegExp(`['"\`]([^'"\`]*${PREFIX}[\\w-]*)['"\`]`, 'gu'))) {
  for (const className of match[1].split(/\s+/u)) {
    if (className.startsWith(PREFIX)) used.add(className);
  }
}
const declared = new Set();
for (const match of css.matchAll(new RegExp(`\\.(${PREFIX}[\\w-]*)`, 'gu'))) declared.add(match[1]);
const missing = [...used].filter((className) => !declared.has(className));
if (missing.length > 0) {
  problems.push(`classes used by the client have no CSS rule: ${missing.join(', ')}`);
}

const unused = [...declared].filter((className) => !used.has(className));
if (unused.length > 0) console.log(`note: CSS rules with no client reference: ${unused.join(', ')}`);

if (problems.length > 0) {
  for (const problem of problems) console.error(`FAIL: ${problem}`);
  console.error(`check-stylesheet: ${problems.length} problem(s)`);
  process.exit(1);
}
console.log(`check-stylesheet: OK — ${declared.size} rules, ${used.size} used classes, ${css.length} chars`);
