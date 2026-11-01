# dsh-session-rewind · 会话回退

A DSH Web plugin that puts **Rewind** on every finished Turn: a per-Turn control
in the Chat timeline plus one entry in the Session header, branching the
conversation at that Turn and restoring the files that Turn changed.

在 DSH Web 里回退到任意**已完成的回合**：对话时间线的每个回合旁有 `回退` 按钮，会话标题栏还有一个
总入口，列出本会话所有可回退的回合；回退会从该回合处分叉出新会话，并把该回合改动过的文件恢复原状。

## 两个入口 · Two entry points

| 位置 | 作用 |
| --- | --- |
| 会话标题栏的 ↶（`conversation.session.header.actions`） | 列出本会话**所有**已完成的回合（第 N 轮 + 提问预览 + 文件数），↑↓ 选择、Enter 确认、Esc 返回；选中后再选「仅回退对话」或「回退并恢复 N 个文件」。不用翻回那一轮。 |
| 每个已完成回合末尾的 `回退`（`conversation.chat.turnTail`） | 直接就这一轮回退，面板里勾选要恢复的文件，可选「回退对话」或「仅恢复文件」。 |

## What it does · 功能

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

The two halves can be used together (`回退对话`) or separately
(`仅恢复文件`).

选中某个回合后：

1. **回退对话**：会话日志是只追加的，所以“回退”= 在该回合的 `turn/end` 处**分叉**出一个新会话并打开它，
   同时把该回合原本的用户输入写回新会话的输入框，你可以直接修改后重新发送；原会话完全不动。
2. **恢复文件**：该回合运行期间，每个被创建或改写的文件都会在**写入前**抓取一份原始字节存档。
   面板会列出这些文件，勾选的会被恢复为修改前的内容；该回合新建的文件会被删除。

### 为什么是“分叉”而不是“就地撤回”

社区里的 [`SiriLee/dsh-rewind`](https://github.com/SiriLee/dsh-rewind) 提供**就地回退**（同一会话内
把模型可见 surface 切回更早的用户消息，靠追加一条 `surfaceOp: replace` 标记实现）。我们借鉴了它的
**入口与交互**（每条消息/每轮旁的 ↶、模式选择、文件影响清单、↑↓/Enter/Esc、标题栏候选列表），但**没有**
采用它的就地撤回，原因是：

- 就地撤回不仅要追加标记，还必须在**前端**把被撤回的行隐藏起来，而 DSH 没有为此提供扩展点——
  参考插件是通过包装私有的 `uiConversation.views` registry 做到的，其源码自己注明
  *"The seam is private … not an extension point"*，随版本升级会破。
- `sessions.fork` 是 DSH 给 UI 的官方分支能力（内置「在新对话中分支」按钮用的就是它），
  升级稳定，且天然满足“上下文被截断 + 可改可重发”。

如果你更希望要就地撤回（同一会话、不产生新会话），可以另装 `dsh-rewind-plugin`；两者不冲突。

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
| conversation | Client `sessions.fork({ sessionId, atSeq })` + `uiWorkspace.openSession`, the same idiom as the built-in branch button; the draft is pre-seeded through the Conversation store's per-session `localStorage` key so the composer already holds the original prompt |
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
- The naming and wording of the panel follow the DSH locale service; the bundled
  dictionaries are Chinese and English.

## Tests · 测试

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
