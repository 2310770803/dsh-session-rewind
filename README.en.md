# dsh-session-rewind

[中文](README.md) | English

A DSH Web plugin that puts **Rewind** on every finished Turn: a per-Turn control
in the Chat timeline plus one entry in the Session header, branching the
conversation at that Turn and restoring the files that Turn changed.

In DSH Web, rewind to any **finished Turn**: every Turn in the Chat timeline has a
`Rewind` button, and the Session header adds one more entry point that lists every
rewindable Turn of the session. Rewinding forks a new session at that Turn and
restores the files that Turn changed.

## Two entry points

| Where | What it does |
| --- | --- |
| The ↶ in the Session header (`conversation.session.header.actions`) | Lists **every** finished Turn of this session (Turn N + prompt preview + file count); pick with ↑↓, confirm with Enter, go back with Esc. After picking a Turn, choose "Rewind conversation only" or "Rewind and restore N files" — no need to scroll back to that Turn. |
| `Rewind` at the end of each finished Turn (`conversation.chat.turnTail`) | Rewinds that one Turn directly; the panel lets you check the files to restore and choose "Rewind conversation" or "Restore files only". |

## What it does

Choosing a Turn opens a small panel with two independent halves:

1. **Rewind the conversation.** A committed Turn cannot be edited in place: the
   session log is append-only and branching is the supported operation. The
   panel therefore creates a *new* session that ends exactly at that Turn
   (`sessions.fork` with the Turn's `turn/end` seq), opens it, and pre-fills its
   composer with the Turn's original user prompt so you can edit it and send it
   again. The original session is left untouched.
2. **Restore the files that Turn changed.** While a Turn runs, every file the
   model creates or rewrites is captured *before* the mutation and stored as a
   content-addressed blob. The panel lists those files; the checked ones are put
   back to their pre-Turn content (a file the Turn created is removed).

The two halves can be used together (`Rewind conversation`) or separately
(`Restore files only`).

### Why a fork instead of an in-place rewind

The community plugin [`SiriLee/dsh-rewind`](https://github.com/SiriLee/dsh-rewind)
offers an **in-place rewind** (inside the same session it moves the
model-visible surface back to an earlier user message by appending a
`surfaceOp: replace` marker). We borrowed its **entry points and interaction**
(a ↶ next to each message/Turn, a mode picker, a file impact list,
↑↓/Enter/Esc, a header candidate list) but deliberately did **not** adopt its
in-place rollback, because:

- An in-place rewind needs more than an appended marker: the front end must also
  hide the rolled-back rows, and DSH exposes no extension point for that. The
  reference plugin does it by wrapping the private `uiConversation.views`
  registry, and its own source comments say *"The seam is private … not an
  extension point"* — it breaks with version upgrades.
- `sessions.fork` is the branching capability DSH officially gives the UI — the
  built-in "branch in new chat" button uses it — so it is stable across upgrades
  and naturally satisfies "context truncated + editable + resendable".

If you would rather have an in-place rewind (same session, no new session), you
can install `dsh-rewind-plugin` separately; the two do not conflict.

## Install

```js
// plugin_manager
{ action: 'install_bundle', target: 'E:\\\\DeepSeek Harness\\\\dsh-session-rewind' }
```

## How it is put together

| half | mechanism |
| --- | --- |
| conversation | Client `sessions.fork({ sessionId, atSeq })` + `uiWorkspace.openSession`, the same idiom as the built-in branch button; the draft is pre-seeded through the Conversation store's per-session `localStorage` key so the composer already holds the original prompt |
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
- The naming and wording of the panel follow the DSH locale service; the bundled
  dictionaries are Chinese and English.

## Tests

The package ships the suites used to verify it; they need no browser and no
profile:

```
node test/selftest.mjs      # Turn location, prompt extraction, archive, restorer
node test/route-smoke.mjs   # all routes, their fences, and path allow-listing
node test/client-smoke.mjs  # the Web half: both slots, panel, candidate list, fork, draft
```

## Package layout

| file | role |
| --- | --- |
| `cordis.patch.yml` | inserts the `session-rewind` plugin row |
| `src/index.js` | Host entry, re-exports `apply` / `inject` / `name` |
| `src/plugin.js` | Host wiring: Turn tracking, mutation capture, the four routes |
| `src/lib/archive.js` | durable pre-Turn archive, pruning, blob store |
| `src/lib/restore.js` | putting one captured file back |
| `src/lib/route.js` | routes and the `/api` trust fence |
| `lib/client.js` | Web half: the turn-tail control, the header entry, the panel |
| `locale/*.json` | `meta.title` / `meta.description` for the plugin list |
| `index.json` | format-1 plugin-market index (see `docs/publishing.md`) |
