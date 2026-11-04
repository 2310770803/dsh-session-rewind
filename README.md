# dsh-session-rewind · 会话回退

A DSH Web plugin that adds an always-visible action beside each user message.
Completed Turns can be rewound in place; active or stopped Turns can be paused and edited.

DSH Web 每条用户消息旁常显一个操作按钮：已完成回合显示 ↶，点击可就地回退；未完成或已停止回合显示铅笔，点击会暂停并撤回旧消息，将原文放回输入框供编辑重发。

## 操作

- **已完成回合 ↶**：撤回该消息及之后的上下文，原文回到输入框；可选同时恢复本插件记录到的文件改动。
- **未完成/已停止回合铅笔**：停止生成，撤回原消息并将原文放回输入框；编辑后发送，界面与模型上下文只保留新版本。
- 对话日志只追加 marker，不物理删除事件；已撤回的消息仍可在轨迹中检查。
- 文件恢复只覆盖通过 DSH filesystem mutation hooks 捕获的变更；shell/git 和直接绕开这些 hooks 的写入不在保证范围内。

## Install · 安装

**从插件市场安装（推荐）**：左侧 **插件 → 发现（Discover）** → **索引源** → 添加
`https://raw.githubusercontent.com/2310770803/dsh-session-rewind/main/index.json`
→ 搜索 `rewind` 或 `会话回退` → 安装。索引格式与发布流程见 [docs/publishing.md](docs/publishing.md)。

本机（profile `desktop`）已把这个索引源写进 `cordis.patch.yml`，打开「发现」即可看到条目。

**从源码目录安装**（本机当前就是这种方式）：

```js
// plugin_manager
{ action: 'install_bundle', target: 'E:\\DeepSeek Harness\\dsh-session-rewind' }
```

## How it is put together · 实现

| half | mechanism |
| --- | --- |
| conversation | Client DOM bridge on the user-message row; completed Turns use the in-place surface replace route, while active/stopped Turns use the edit route and composer facade |
| files (capture) | `fs/write-intent` / `fs/edit-intent` waterfalls (`{ prepend: true }`), with the tool execution mapped back to its Session through a `tools/pre-execute` `WeakMap` — the same coupling `workspace-changes` uses |
| files (restore) | text pre-images through the `fs` service (path resolution, locks, version guard); binary pre-images and deletions through Node, on the archive's own recorded absolute path |

## Where data lives · 数据位置

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

## Limits · 限制

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

## Tests · 测试

The package ships the suites used to verify it; they need no browser and no
profile:

```
node test/selftest.mjs       # surface planning, archive and restore
node test/edit-smoke.mjs     # active edit cancellation and surface replacement
node test/route-smoke.mjs    # routes, trust fences and path allow-listing
node test/client-smoke.mjs   # single bridge host and message action wiring
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
