# dsh-session-rewind

A DSH Web plugin with one always-visible action beside each user message. Completed Turns show ↶ for in-place rewind; active or stopped Turns show a pencil for pause-and-edit.

## Behavior

- **Completed Turn ↶**: withdraws that message and later model context, optionally restores captured filesystem changes, and puts the original prompt back in the composer.
- **Active or stopped Turn pencil**: stops generation, withdraws the original prompt without the rewind dialog, and returns it to the composer for editing. Sending the edit leaves only the new version visible to the model and in Chat.
- The event log remains append-only. Hidden rows are a presentation layer; the trajectory remains inspectable.
- File restoration only covers mutations captured through DSH filesystem hooks.

## Install

**Install from the plugin market (recommended):** **Plugins → Discover** →
**Index sources** → add
`https://raw.githubusercontent.com/2310770803/dsh-session-rewind/main/index.json`
→ search `rewind` or `Session Rewind` → install. The index format and the release
process are documented in [docs/publishing.md](docs/publishing.md).

This machine (profile `desktop`) already has that index source written into
`cordis.patch.yml`, so opening Discover shows the entry.

**Install from the source directory** (what this machine currently does):

```js
// plugin_manager
{ action: 'install_bundle', target: 'E:\\\\DeepSeek Harness\\\\dsh-session-rewind' }
```

## How it is put together

| half | mechanism |
| --- | --- |
| conversation | Client DOM bridge on the user-message row; completed Turns use the in-place surface replace route, while active/stopped Turns use the edit route and composer facade |
| files (capture) | `fs/write-intent` / `fs/edit-intent` waterfalls (`{ prepend: true }`), with the tool execution mapped back to its Session through a `tools/pre-execute` `WeakMap` — the same coupling `workspace-changes` uses |
| files (restore) | text pre-images through the `fs` service (path resolution, locks, version guard); binary pre-images and deletions through Node, on the archive's own recorded absolute path |

## Where data lives

```
$DSH_HOME/plugin-data/dsh-session-rewind/
  index.json           per-session, per-Turn file records
  blobs/<sha256>.bin   the pre-Turn bytes
```

Nothing leaves the machine: the four Host routes are loopback-only,
same-origin `/api` routes with DSH Web's own Host/Origin trust fence.

`GET /api/session-rewind.selfcheck` reports what the running Host has actually
wired up (archive totals, whether the Web half is in the boot graph, the route
list). It is read-only and never exposes session content.

## Limits

- Only mutations that go through the DSH filesystem service inside a Turn are
  captured. Files changed by a shell command, by `git`, or outside a Turn are
  not recorded and therefore not restored.
- Files written by tools that bypass the `fs` write-intent waterfall are not
  captured either: the Office tools (`word_create`, `excel_update`, …) call the
  filesystem service directly, so a `.docx`/`.xlsx` they produce is **not** in the
  archive and cannot be rewound. Plain text, Markdown, and source code edited
  through the `write`/`edit` tools are covered.
- A Turn snapshots at most 200 files, and no pre-image larger than 2 MiB; larger
  files are listed as "not restorable" instead of being silently skipped.
- Files inside `.git` are never captured, so a restore cannot corrupt the
  repository.
- The archive keeps the newest 400 Turns; older records are pruned with their
  blobs.
- A restore writes the recorded content back. It does not re-run anything, and it
  does not delete files the Turn merely *modified*.
- A plugin-originated write has no Agent context, so the `fs` service refuses it
  by default. Restores rebuild the policy from the Turn's own workspace
  (`workspace-write`) and widen to `danger-full-access` only for a path the
  archive recorded outside it.
- Capture starts with the Turn that is open when the plugin mounts: a Turn
  already running at install time is recovered from the live log tail, but a
  plugin loaded later than the Turn's first write cannot see earlier mutations.
- The plugin-list metadata and client notices are localized in Chinese and English.

## Tests

The shipped suites need no browser or profile:

```
node test/selftest.mjs
node test/edit-smoke.mjs
node test/route-smoke.mjs
node test/client-smoke.mjs
```

## Package layout

| file | role |
| --- | --- |
| `cordis.patch.yml` | inserts the `session-rewind` plugin row |
| `src/index.js` | Host entry |
| `src/plugin.js` | Host wiring, capture hooks and API routes |
| `src/lib/archive.js` | durable pre-Turn archive and blob store |
| `src/lib/inplace.js` | active edit and in-place rewind execution |
| `src/lib/restore.js` | restore one captured file |
| `src/lib/route.js` | HTTP routes and trust fence |
| `src/lib/surface.js` | surface planning, markers and withdrawn-turn calculation |
| `lib/client.js` | hidden bridge host and per-message edit/rewind control |
| `locale/*.json` | plugin-list metadata |
| `index.json` | format-1 plugin-market index |
