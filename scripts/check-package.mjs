#!/usr/bin/env node
/**
 * Validate this package against the DSH plugin contract before installing or
 * publishing it. Read-only: it never writes into a profile.
 *
 * Why not a copy-installer: this plugin is installed through the supported
 * `plugin_manager install_bundle` path (or, once published, `dsh plugin add`).
 * Hand-copying files into `profile/node_modules` would create a second
 * installation that silently drifts from the one the Host actually loads, so the
 * useful half of that idea — the checks — is all this keeps.
 *
 * Usage
 *   node scripts/check-package.mjs
 * Exit code 0 = publishable, 1 = something the catalog or the Host will reject.
 */

import { readFileSync, statSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const MAX_ICON_BYTES = 256 * 1024;

const failures = [];
const notes = [];

const fail = (message) => failures.push(message);
const note = (message) => notes.push(message);

const readJson = (path) => JSON.parse(readFileSync(join(ROOT, path), 'utf8'));

// ---------------------------------------------------------------- manifest
let manifest;
try {
  manifest = readJson('package.json');
} catch (error) {
  console.error(`package.json is not valid JSON: ${error.message}`);
  process.exit(1);
}

if (typeof manifest.name !== 'string' || !/^[a-z0-9][a-z0-9._-]*$/u.test(manifest.name)) {
  fail(`package name "${String(manifest.name)}" is not a valid npm name`);
}
if (typeof manifest.version !== 'string' || !/^\d+\.\d+\.\d+/u.test(manifest.version)) {
  fail(`version "${String(manifest.version)}" is not semver`);
}
if (manifest.private === true) fail('package is marked private, so it cannot be published');

// The two halves of the plugin row. Missing `dsh.bundle` is what the catalog CI
// rejects first; a missing `dsh.client` alone produces a Host-only plugin.
const bundle = manifest.dsh?.bundle;
const client = manifest.dsh?.client;
if (bundle === undefined || typeof bundle.patch !== 'string') {
  fail('dsh.bundle.patch is required (or the plugin row never mounts)');
} else if (!fileExists(bundle.patch)) {
  fail(`dsh.bundle.patch "${bundle.patch}" does not exist`);
}
if (client === undefined) {
  fail('dsh.client is required for the browser half');
} else {
  if (client.platform !== 'web') fail(`dsh.client.platform should be "web", got "${String(client.platform)}"`);
  if (!Array.isArray(client.inject)) fail('dsh.client.inject should be an array');
  else {
    for (const dependency of client.inject) {
      if (typeof dependency !== 'string' || !dependency.startsWith('@deepseek-ai/')) {
        fail(`dsh.client.inject contains a non-DSH package: ${String(dependency)}`);
      }
    }
  }
}
if (manifest.dsh?.manifestVersion !== 1) fail('dsh.manifestVersion must be 1');

// ---------------------------------------------------------------- exports
const exported = manifest.exports ?? {};
const expectedExports = [
  ['.', manifest.main === undefined ? './src/index.js' : manifest.main],
  ['./client', './lib/client.js'],
  ['./cordis.patch.yml', './cordis.patch.yml'],
  ['./icon', manifest.icon ?? './icon.svg'],
];
for (const [key, target] of expectedExports) {
  const value = exported[key];
  const resolved = typeof value === 'string' ? value : value?.default;
  if (typeof resolved !== 'string') {
    fail(`exports["${key}"] is required`);
    continue;
  }
  if (!fileExists(resolved)) fail(`exports["${key}"] points at a missing file: ${resolved}`);
  if (target !== undefined && resolved !== target) note(`exports["${key}"] is "${resolved}" (usual: "${target}")`);
}
if (typeof exported['./locale/*.json'] !== 'string') {
  fail('exports["./locale/*.json"] is required — the plugin card reads meta.title/description from it');
}
if (typeof exported['./package.json'] !== 'string') fail('exports["./package.json"] is required');

// ---------------------------------------------------------------- peer deps
// A DSH range such as ">=0.2.0-rc.2 <1.0.0" satisfies DSH's own prerelease-aware
// check but makes a plain `npm install` fail with ERESOLVE.
for (const [name, range] of Object.entries(manifest.peerDependencies ?? {})) {
  if (!name.startsWith('@deepseek-ai/')) continue;
  if (typeof range !== 'string') {
    fail(`peerDependencies["${name}"] must be a string`);
    continue;
  }
  const mentionsPrerelease = /-(rc|alpha|beta|next)/u.test(range);
  if (!mentionsPrerelease) {
    fail(
      `peerDependencies["${name}"] = "${range}" spans a prerelease without naming the branches; `
      + 'use e.g. ">=0.2.0-rc.2 <0.2.1 || >=0.2.1-rc.1 <0.3.0-0 || >=0.3.0-rc.1 <1.0.0-0"',
    );
  }
}

// ---------------------------------------------------------------- icon
const iconPath = manifest.icon ?? './icon.svg';
if (!fileExists(iconPath)) {
  fail(`icon "${iconPath}" does not exist`);
} else if (statSync(join(ROOT, iconPath)).size > MAX_ICON_BYTES) {
  fail(`icon "${iconPath}" is larger than 256 KiB`);
}
const raster = ['assets/icon-180.png', 'assets/icon-192.png', 'assets/icon.png'].find(fileExists);
if (raster === undefined) {
  note('no square raster icon found (assets/icon-180.png) — the community catalog only accepts a GitHub-hosted png/jpg/webp');
}

// ---------------------------------------------------------------- locales
const locales = ['locale/en.json', 'locale/zh.json'];
for (const path of locales) {
  if (!fileExists(path)) {
    fail(`${path} is missing`);
    continue;
  }
  try {
    const value = readJson(path);
    if (typeof value?.meta?.title !== 'string' || value.meta.title.trim() === '') fail(`${path}: meta.title is required`);
    if (typeof value?.meta?.description !== 'string' || value.meta.description.trim() === '') {
      fail(`${path}: meta.description is required`);
    }
  } catch (error) {
    fail(`${path} is not valid JSON: ${error.message}`);
  }
}

// ---------------------------------------------------------------- client half
const clientPath = join(ROOT, 'lib/client.js');
if (!fileExists('lib/client.js')) {
  fail('lib/client.js is missing');
} else {
  const source = readFileSync(clientPath, 'utf8');
  if (!source.includes('window.__ModuleLoader__') || !source.includes('.load(')) {
    fail('lib/client.js must call window.__ModuleLoader__.load({ id, factory })');
  }
  // Skip the leading block comment before looking for the wrapper.
  const withoutHeader = source.replace(/^\s*\/\*[\s\S]*?\*\//u, '').trimStart();
  const opensWithIife = /^\(\s*\(\s*\)\s*=>\s*\{/u.test(withoutHeader) || /^\(\s*function\s*\(\s*\)\s*\{/u.test(withoutHeader);
  if (!opensWithIife) {
    fail('lib/client.js must be wrapped in an IIFE, or an HMR reload dies on a duplicate declaration');
  }
  if (!/\}\)\s*\(\s*\)\s*;?\s*$/u.test(source.trimEnd())) note('lib/client.js does not visibly close its IIFE at EOF');
  if (/\btypeof\s+[A-Za-z_$][\w$]*\.Button\s*===\s*['"]function['"]/u.test(source)) {
    fail('do not feature-detect a primitives component with typeof x.Button === "function" — Button is a forwardRef object');
  }
}

// ---------------------------------------------------------------- leftovers
const stale = ['dsh-rewind-plugin', 'dshSessionCopy'];
const sources = ['package.json', 'cordis.patch.yml', 'lib/client.js', 'src/plugin.js'];
for (const path of sources) {
  if (!fileExists(path)) continue;
  const text = readFileSync(join(ROOT, path), 'utf8');
  for (const name of stale) {
    if (text.includes(name)) fail(`${path} still references "${name}"`);
  }
}

// ---------------------------------------------------------------- report
for (const message of notes) console.log(`note: ${message}`);
if (failures.length === 0) {
  console.log(`check-package: OK — ${manifest.name}@${manifest.version} satisfies the DSH plugin contract`);
  process.exit(0);
}
for (const message of failures) console.error(`FAIL: ${message}`);
console.error(`check-package: ${failures.length} problem(s)`);
process.exit(1);

function fileExists(relative) {
  try {
    return statSync(join(ROOT, relative)).isFile();
  } catch {
    return false;
  }
}
