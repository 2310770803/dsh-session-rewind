#!/usr/bin/env node
/**
 * Build the format-1 DSH plugin market index for dsh-session-rewind.
 *
 * Why this file exists: DSH's Plugins -> Discover tab and the `plugin_market`
 * agent tool read "plugin market indexes" — JSON documents validated by
 * `@deepseek-ai/dsh-plugin-market-index`. Format 1 supports npm sources and
 * Git sources pinned to a commit. npm is not authenticated for this project, so
 * the index here carries a Git source pinned to one commit; that is enough for
 * Discover to list the plugin and install it straight from GitHub:
 *
 *   Plugins -> Discover -> Index sources -> add
 *   https://cdn.jsdelivr.net/gh/2310770803/dsh-session-rewind@main/index.json
 *
 * The pinned commit is the one named by --commit, defaulting to HEAD. `index.json`
 * must describe a commit that already exists, and it cannot describe the commit
 * that contains it (the file's own hash would be part of that commit), so the
 * release flow is: commit the code, regenerate, then commit index.json.
 *
 * Usage
 *   node scripts/build-index.mjs                    write index.json pinned to HEAD
 *   node scripts/build-index.mjs --check            fail if index.json is stale
 *   node scripts/build-index.mjs --commit <sha>     pin an explicit commit
 *   node scripts/build-index.mjs --dry-run          print the document, write nothing
 *
 * Environment
 *   SOURCE_DATE_EPOCH   Unix seconds to use as publishTimestamp when the pinned
 *                       commit is not in this clone (standard reproducible-build
 *                       variable; CI never needs it because the commit is there).
 *
 * Only the Node.js standard library is used: this must run with plain `node`
 * before any dependency is installed, and its output must be byte-identical on
 * every run (--check compares bytes, not semantics).
 */

import { execFileSync } from 'node:child_process';
import { readFileSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const PLUGIN_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const INDEX_FILE = join(PLUGIN_ROOT, 'index.json');

/** The GitHub repository this index installs the plugin from. */
const REPO_URL = 'https://github.com/2310770803/dsh-session-rewind';
/** Raw file access for the icon; the GitHub default branch is `main`. */
const RAW_BASE = 'https://raw.githubusercontent.com/2310770803/dsh-session-rewind/main';
/** jsDelivr mirror of the same branch, which is what Discover fetches (it is fast and CDN-cached). */
const JSDELIVR_BASE = 'https://cdn.jsdelivr.net/gh/2310770803/dsh-session-rewind@main';

/** The index's own display metadata; it is about the index, not about the plugin. */
const INDEX_TITLE = {
  en: 'dsh-session-rewind',
  zh: 'dsh-session-rewind',
};
const INDEX_DESCRIPTION = {
  en: 'A single-plugin index, so Plugins -> Discover and the plugin_market tool can list and install dsh-session-rewind without npm.',
  zh: '单插件索引：不经过 npm，也能在「插件 → 发现」和 plugin_market 工具里浏览并安装 dsh-session-rewind。',
};

/**
 * Categories this index declares. A plugin may only reference declared ids, and
 * `session` is the one this plugin belongs to (one rewind control per finished
 * Turn in the Chat timeline).
 */
const CATEGORIES = {
  session: { title: { en: 'Sessions', zh: '会话' } },
};
const CATEGORY_ID = 'session';

function git(...args) {
  // stderr is piped, not inherited: a missing repository or an unknown commit is
  // an expected probe (HEAD before the first commit, SOURCE_DATE_EPOCH preview),
  // and the friendly error this script throws is more useful than `git`'s own.
  return execFileSync('git', args, {
    cwd: PLUGIN_ROOT,
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
  }).trim();
}

/** The commit named on the command line, or undefined when none was named. */
function namedCommit(argv) {
  const at = argv.indexOf('--commit');
  if (at === -1) return undefined;
  const named = argv[at + 1];
  if (named === undefined || !/^[0-9a-f]{40}$/u.test(named)) {
    throw new Error('--commit needs a lowercase 40-hex-digit commit SHA');
  }
  return named;
}

/** The commit the index pins: --commit when given, else HEAD. */
function resolveCommit(argv) {
  return namedCommit(argv) ?? git('rev-parse', 'HEAD');
}

/**
 * Unix seconds of a commit, which is the closest thing a Git source has to a
 * publish time. A commit that is not in this clone (a shallow CI checkout of a
 * tag, or a --dry-run before the repository exists) has no readable time, so
 * SOURCE_DATE_EPOCH is the deterministic override rather than "now".
 */
function commitTimestamp(commit) {
  try {
    return Number(git('show', '-s', '--format=%ct', commit));
  } catch {
    const override = process.env.SOURCE_DATE_EPOCH;
    if (override !== undefined && /^\d+$/u.test(override)) return Number(override);
    throw new Error(
      `cannot read the commit time of ${commit}; pass SOURCE_DATE_EPOCH=<unix seconds> `
      + 'when the commit is not present in this clone',
    );
  }
}

function readJson(path) {
  return JSON.parse(readFileSync(path, 'utf8'));
}

/**
 * The DSH requirement the host checks before offering an install.
 *
 * Taken from the manifest's own `engines.dsh` when present, else from the
 * lockstep `@deepseek-ai/dsh-*` peer range. This package currently declares
 * neither, so the field is omitted: Discover then reports no declared range
 * instead of a made-up one. It is regenerated automatically when package.json
 * starts declaring one.
 */
function dshRequirement(manifest) {
  const declared = manifest.engines?.dsh ?? manifest.dsh?.engines?.dsh;
  if (typeof declared === 'string' && declared.trim() !== '') return declared.trim();
  const peers = Object.entries(manifest.peerDependencies ?? {});
  const lockstep = peers
    .filter(([name]) => /^@deepseek-ai\/dsh(?:-|$)/u.test(name))
    .map(([, range]) => range);
  const ranges = [...new Set(lockstep)];
  // Format 1 carries a single range and the host check is conjunctive; only an
  // unambiguous lockstep is honest to summarize, so differing ranges are omitted.
  return ranges.length === 1 ? ranges[0] : undefined;
}

/** The document Discover reads. Deterministic: same commit + manifest => same bytes. */
function buildIndex(commit) {
  const manifest = readJson(join(PLUGIN_ROOT, 'package.json'));
  const localeEn = readJson(join(PLUGIN_ROOT, 'locale', 'en.json'));
  const localeZh = readJson(join(PLUGIN_ROOT, 'locale', 'zh.json'));
  const dsh = dshRequirement(manifest);

  const title = { en: localeEn.meta?.title ?? manifest.name };
  if (localeZh.meta?.title !== undefined) title.zh = localeZh.meta.title;
  const description = { en: localeEn.meta?.description ?? manifest.description };
  if (localeZh.meta?.description !== undefined) description.zh = localeZh.meta.description;

  return {
    format: 1,
    title: INDEX_TITLE,
    description: INDEX_DESCRIPTION,
    metadata: { categories: CATEGORIES },
    plugins: [
      {
        name: manifest.name,
        title,
        description,
        // The package ships icon.svg and no raster copy; raw.githubusercontent
        // serves it as image/svg+xml, which the Discover entry renders directly.
        icon: `${RAW_BASE}/icon.svg`,
        author: '2310770803',
        homepage: `${REPO_URL}#readme`,
        repository: { url: REPO_URL },
        metadata: {
          category: CATEGORY_ID,
          keywords: [...(manifest.keywords ?? [])],
        },
        versions: [
          {
            version: manifest.version,
            publishTimestamp: commitTimestamp(commit),
            source: { type: 'git', url: REPO_URL, commit },
            ...dsh === undefined ? {} : { engines: { dsh } },
          },
        ],
      },
    ],
  };
}

/**
 * The rules format 1 enforces that this generator could actually get wrong.
 * The host's own validator is authoritative; this catches a broken build before
 * it reaches a commit, without adding a dependency to a dependency-free package.
 */
function validate(index) {
  const fail = (why) => {
    throw new Error(`generated index is not a format-1 document: ${why}`);
  };
  if (index.format !== 1) fail('format must be 1');
  if (typeof index.title?.en !== 'string' || index.title.en.trim() === '') fail('title.en is required');
  const plugin = index.plugins?.[0];
  if (!plugin) fail('exactly one plugin is expected');
  if (!/^(?:@[a-z0-9][a-z0-9._~-]*\/)?[a-z0-9][a-z0-9._~-]*$/u.test(plugin.name)) fail('invalid plugin name');
  if (!Object.hasOwn(index.metadata.categories, plugin.metadata?.category)) fail('plugin names an undeclared category');
  if (typeof plugin.title?.en !== 'string' || plugin.title.en.trim() === '') fail('plugin title.en is required');
  if (typeof plugin.description?.en !== 'string' || plugin.description.en.trim() === '') fail('plugin description.en is required');
  if (typeof plugin.icon !== 'string' || !plugin.icon.startsWith('https://')) fail('icon must be an absolute https URL');
  const version = plugin.versions?.[0];
  if (!version) fail('one version is expected');
  if (!/^(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?$/u.test(version.version)) fail('version must be exact SemVer');
  if (!Number.isInteger(version.publishTimestamp) || version.publishTimestamp < 0 || version.publishTimestamp >= 1e11) fail('publishTimestamp must be Unix seconds');
  if (version.source?.type !== 'git') fail('source.type must be git');
  if (version.source.url !== REPO_URL) fail('source.url must be the canonical repository URL');
  if (!/^[0-9a-f]{40}$/u.test(version.source.commit)) fail('source.commit must be a lowercase 40-hex SHA');
}

/** Serialized form: two-space indent and a trailing newline, so diffs stay readable and --check is byte-exact. */
function serialize(index) {
  return `${JSON.stringify(index, null, 2)}\n`;
}

/** The commit an existing index.json pins, or undefined when there is none. */
function pinnedCommit() {
  try {
    const existing = JSON.parse(readFileSync(INDEX_FILE, 'utf8'));
    const commit = existing.plugins?.[0]?.versions?.[0]?.source?.commit;
    return typeof commit === 'string' && /^[0-9a-f]{40}$/u.test(commit) ? commit : undefined;
  } catch {
    return undefined;
  }
}

function main(argv) {
  const dryRun = argv.includes('--dry-run');

  if (argv.includes('--check')) {
    // Compare against the commit the file itself pins, not against HEAD: the
    // index is always committed after the code it points at, so regenerating at
    // HEAD would report every committed index as stale. An explicit --commit
    // still wins, so CI can also check "this file describes this tag".
    const commit = namedCommit(argv) ?? pinnedCommit();
    if (commit === undefined) {
      console.error('index.json is missing or has no pinned commit — run `node scripts/build-index.mjs`');
      process.exitCode = 1;
      return;
    }
    const expected = serialize(buildIndex(commit));
    let existing = '';
    try {
      existing = readFileSync(INDEX_FILE, 'utf8');
    } catch {
      console.error('index.json is missing — run `node scripts/build-index.mjs`');
      process.exitCode = 1;
      return;
    }
    if (existing !== expected) {
      console.error(`index.json does not match package.json/locale/icon pinned at ${commit} — regenerate it`);
      process.exitCode = 1;
      return;
    }
    const plugin = JSON.parse(existing).plugins[0];
    console.log(`index.json is current (${plugin.name}@${plugin.versions[0].version} at ${commit})`);
    return;
  }

  let commit;
  try {
    commit = resolveCommit(argv);
  } catch (error) {
    if (namedCommit(argv) === undefined) {
      throw new Error(
        'cannot resolve HEAD: initialise the repository and make the first commit, '
        + 'or pass --commit <sha> explicitly',
      );
    }
    throw error;
  }

  const index = buildIndex(commit);
  validate(index);
  const text = serialize(index);

  if (dryRun) {
    process.stdout.write(text);
    return;
  }
  writeFileSync(INDEX_FILE, text);

  const plugin = index.plugins[0];
  console.log(`wrote index.json — ${plugin.name}@${plugin.versions[0].version} pinned at ${commit}`);
  console.log(`add this index source in DSH: Plugins -> Discover -> Index sources -> ${JSDELIVR_BASE}/index.json`);
}

try {
  main(process.argv.slice(2));
} catch (error) {
  console.error(`build-index: ${error instanceof Error ? error.message : String(error)}`);
  process.exitCode = 1;
}
