# 就地回退（in-place rewind）实现契约

- **参考实现** `E:\DeepSeek Harness\.ref-dsh-rewind`（`dsh-rewind` v0.20.0-alpha.1，SiriLee）。下文路径相对该目录，`file:line` 为其真实行号。
- **本机 DSH `0.2.1-rc.5`**。`app.asar:<n>` 是写作时该 archive 的 `grep -a -n` 行号，会随版本失效；**以引号里的声明原文为准**。两处冲突时以本机为准，全部冲突见 §6。

## 0. 五条结论

1. 按钮 = **两个入口**：`conversation.session.header.actions`（会话级 list slot，只挂一个"门户桥"）＋ 每条用户消息行的 React `createPortal` ↶。后者是必需的：DSH **没有** per-user-message 动作槽。
2. 就地回退 = **一次 append**：`session.append('user/message', marker, { surfaceOp: {op:'replace',startSeq,endSeq}, sourceEventSeqs })`。只剪模型可见面，日志一条不删（`src/index.ts:786-789`）。
3. **Host append 不会让 Chat 隐藏旧行**（Chat 只按 append-origin 事件建行，`app.asar:454564`）→ 必须在客户端 wrap `chat` view builder 把区间节点标 `visibility:'hidden'`。**Lead 必须动 client 半边。**
4. Composer 回填 = `conversation.input.for(ctx.sessions.scope(id)).setDraft(text)` + `.focus()`，图片走 `createDrafts` + `addAttachments`。
5. **不要照抄 `engines.dsh`**：参考写 `>=0.2.2-alpha.2 <0.3.0-0`，本机 0.2.1-rc.5 低于下界，照抄会被装载准入拒绝。

## 1. 入口：↶ 按钮挂在哪

### 1.1 slot 注册点

```ts
// src/client/index.ts:99,342-352
const HEADER_ACTIONS_SLOT = 'conversation.session.header.actions'
yield slots.inject(HEADER_ACTIONS_SLOT, () => slots.register(
  { name: HEADER_ACTIONS_SLOT, id: 'dsh-rewind-portals', order: 1000 },   // 只做门户，不画 header UI
  createRewindBridge({ sessionOf, chatOf, isMainViewSession, watchChat, setComposerText, restoreImages, t, subscribeLocale }),
))
// app.asar:481219 本机槽位声明
"conversation.session.header.actions": { kind: "list", scope: "session" }
```

桥组件只依赖 `sessionId`（`src/client/portals.tsx:934-938`）；本机 slot 的 `inject` 就是带 `sessionId` 调的（`app.asar:500347`），现有插件也直接读 `props.sessionId`（`dsh-session-rewind/lib/client.js:316,668`）——可放心用。桥**不渲染任何元素**，只 `return targets.map(... createPortal(...))`（`src/client/portals.tsx:742-770`）。

### 1.2 为什么光有 slot 不够

`conversation.chat.assistant-actions` 只服务 assistant 行；user/steering 行没有对应槽（`docs/compat/audit.md` U2："assistant rows have `conversation.chat.assistant-actions`, user / steering rows have no counterpart"）。所以按钮只能门户进 DOM，耦合 5 个 data 属性（`src/client/portals.tsx:27-30`）；本机都还在：`data-chat-flow-kind`、`data-chat-anchor-key`、`data-composer-input`、`data-composer-card`、`data-pending-steering`（`data-time-hover-root` 已删且无人读）。

### 1.3 锚点定位

```ts
// src/client/portals.tsx:393
const USER_SEAT_SELECTOR = '[data-chat-flow-kind="user"][data-chat-anchor-key], [data-chat-flow-kind="steering"][data-chat-anchor-key]'
// src/client/portals.tsx:432-447（摘）
const buttons = Array.from(row?.querySelectorAll('button') ?? [])
const lastButton = buttons.filter(b => !b.classList.contains(CLASS.button)).at(-1)   // 跳过自己
const structural = lastButton?.parentElement                                        // 复制/分支按钮的容器
if (structural instanceof HTMLElement && structural.querySelector('button') !== null) return structural
```

**锚点 = 最后一个 button 的父节点**，不能用第一个（带图消息的缩略图也是 `<button>` 且文档序更靠前），也不能按 `data-clock`（那是时钟位置）。配对：`chat.order` × `chat.nodes` → `{key,seq,time,preview}`，`rows.get(key)` 取 DOM 行（`454-474`）。找不到就**不挂**，绝不挂错行。

### 1.4 靠什么一直挂着

三路输入 + microtask 合并 + diff（`src/client/portals.tsx:648-740`）：

```ts
// src/client/portals.tsx:683-690,722-731
const queueRefresh = () => { if (queued || !active) return; queued = true; queueMicrotask(() => { queued = false; refresh() }) }
const unsubscribeChat = watchChat(sessionId, queueRefresh)          // uiConversation "chat" 视图 subscribe
const observer = new MutationObserver(r => { /* closest(IGNORED_PORTAL_SCOPE) 则跳过 */ queueRefresh() })
observer.observe(document.body, { childList: true, subtree: true })
```

- `IGNORED_PORTAL_SCOPE`（`402-408`）忽略 composer/右栏/plugins 页，否则每次击键都扫全篇；`sameTargets`（676）避免无变化重渲染。
- 会话切换要重绑 `inbox` 投影订阅（`704-715`）：pending steering 气泡是本地回显，Host 落库那一帧 DOM 不变，只靠 observer 会漏挂。
- 卸载 `closePopover()` + `style.remove()`（`src/client/index.ts:469-477`）：popover 是裸 DOM + document 捕获期键盘监听，不随 fiber 走会偷键盘。

### 1.5 点击流程

1. `RewindButton.onClick`（`src/client/portals.tsx:787-807`）：`stopPropagation()` → `openPopover({seq,time,preview,anchor:event.currentTarget,onRewind})`。
2. **模式弹层**（`src/client/popover.ts:501-534`）：`仅回退对话` 常驻；`回退对话和文件` 在打开时就发一次 impact 预览——loading 时 disabled，无改动换一行说明，预览失败显示 Host 原因并**隐藏该入口**（不卡在 "checking…"）。
3. **影响清单步**（`248-307`）：列 `restore:`/`delete:` 路径，`backupOff` 加说明；确认按钮数据到前 disabled，到后自动 `focus()`。
4. **键盘**（`1-15,322-398,542-563`）：`↑/↓` 只在当前步可聚焦按钮间循环（ghost 的 back/cancel 不进环）；`Enter` 原生激活；`Esc` = ghost 键替身（modes 取消 / impact 返回）；监听挂 **document 捕获期**（`378`），把 `ArrowUp`（composer 历史召回）抢走；外点关闭，滚动/resize 每帧合并定位。
5. **回合运行中**：Host 先 `cancel` 再 append（§2.5），客户端只等 outcome（`waitForCommand` 20s，`src/client/portals.tsx:298-308`）。**pending steering 行**走另一条路：单确认 → `session.updateQueue({kind:'remove'})`，**不打断运行**（`855-889`；未 claim 的消息模型从未看见）。

### 1.6 `/rewind`、`/undo`

```ts
// src/index.ts:1274-1300（三段独立 try/catch，同名被占只降级该名字）
yield ctx.commands.register({ name: 'rewind', description: t('command.description'), handler: rewindHandler })
yield ctx.commands.register({ name: 'undo',   description: t('command.undoDescription'), handler: rewindHandler })
yield ctx.commands.register({ name: ENGINE_COMMAND /* 'rewind-plugin' */, description: ..., input: { hint: ... }, handler: engineHandler })
```

本机 `CommandDefinition` = `{definitionId?, name, description, input?:{hint}, recordInput?, handler}`（`description` **必填**）；`CommandResult = {kind:'success', text?, sourceEventSeq?} | {kind:'error', text}`。成功必须回 **`sourceEventSeq: marker.seq`**——客户端靠它认"marker 已落地"（`src/index.ts:846-850`）。

客户端**不重写菜单**：裸 `/rewind` 用 `commandUi.decorate` 打开 DSH 自己的 popupSelect，选中后走与按钮**完全相同**的模式弹层：

```ts
// src/client/index.ts:427-463（摘）
{ available: s => hasCandidates(s.sessionId), ui: {
    kind: 'popupSelect',
    options: async s => rewindOptionsFromCandidates(await fetchHostCandidates(face), t),   // 完整候选表由 Host 算
    onSelect: (option, s) => openPopover({ session: face, seq, time, preview, anchor: composerAnchor(), onRewind: ... }) } }
```

本机 `decorate` 与官方用例同形（`app.asar:459984`；用例 `500364-500382`）。候选表**必须**由 Host 从 `session.snapshotEvents()` 全量 log 算，不能用已加载的历史窗口。参考走 Connection RPC；**我们更省事**：现有插件的 `/api/session-rewind.candidates` 路由已在用（`lib/client.js:64,765`）。

## 2. 就地回退契约

### 2.1 那次 append

```ts
// src/index.ts:783-795
const marker = buildMarker()
try {
  event = agent.session.append('user/message', marker, {
    surfaceOp: { op: 'replace', startSeq: plan.surfaceStart, endSeq: plan.surfaceEnd },
    sourceEventSeqs: [...plan.shadowedSeqs],
  })
} catch (error) { return { kind: 'error', text: t('failed', { error: error.message }) } }
```

本机签名（已确认，**同步**，且在写日志前校验）：

```ts
append<T>(type: T, data: SessionEventMap[T], ...opts: T extends SurfaceEventType ? [opts: SurfaceIntent<T>] : []): SessionEvent<T>;
type SurfaceIntent<T> = { surfaceOp: SurfaceOp } & (T extends 'assistant/message' ? { sourceEventSeqs?: never } : { sourceEventSeqs?: SessionSeq[] });
type SurfaceOp = 'append' | { op: 'replace'; startSeq: SessionSeq; endSeq: SessionSeq };
// SessionSurface = { nodes: readonly SessionSeq[]; replaceGeneration: number; contentGeneration: number }
```

普通消息也要写 `surfaceOp:'append'`；`assistant/message` 禁止 `sourceEventSeqs`——这就是 marker 只能是 `user/message` 的原因（`docs/compat/audit.md` U1）。

### 2.2 marker 载荷与 `MessageSourceMap`

```ts
// src/index.ts:469,479-484
const REWIND_MARKER_CONTENT: ContentBlock[] = [{ type: 'text', text: '(empty message)' }]
function buildMarker(): UserMessage {
  return createUserMessage({ content: REWIND_MARKER_CONTENT, source: REWIND_MARKER_SOURCE })
}
// src/marker.ts:12-22
declare module '@deepseek-ai/dsh-llm' { interface MessageSourceMap { 'dsh-rewind': { kind: 'dsh-rewind' } } }
export const REWIND_MARKER_SOURCE = Object.freeze({ kind: 'dsh-rewind' } as const)
```

- `UserMessage = MessageBase & {role:'user'}`，`MessageBase = {id: MessageId; content: readonly ContentBlock[]; source: MessageSource}`；`createUserMessage({content,source})` 自补 `role` 与 `id`（`app.asar:1659040-1659068`）。**不要手写 `id`。**
- 内容必须**常量非空**：真空调用户在严格 OpenAI 兼容网关 400（`src/index.ts:459-468`，issue #21）。
- 本机 `MessageSourceMap` **无 `plugin` 兜底 kind**（键集止于 `webhook`），所以 TS 必须模块增强；运行时宽容——未知 kind 走 `{role:'inject', label: kind}`、`contextForm` 返回 `null`，不抛（`app.asar:452462-452480`）。
- 我们自己的 kind 建议用 **`session-rewind`**（与包名一致），改名不影响任何宿主逻辑。

### 2.3 目标与区间（纯函数，可直接翻 JS）

输入只有两个：`events = session.snapshotEvents()`（全量 log）与 `surface = session.surface.nodes`（**有序 seq 数组**）。

```ts
// src/rewind.ts
108-112  isHumanUserMessageEvent = e => e.type === 'user/message' && e.data.source.kind === 'user'
164-187  listRewindCandidates(events, surface, limit=100)   // 倒序扫 events，仅 surface 内，index 从 1 起
197-246  planRewind(events, surface, target):
           targetEvent = events.find(e => e.seq === seq)
           assert isHumanUserMessageEvent(targetEvent)     // 否则 not-a-user-message
           targetIndex = surface.indexOf(seq)
           if (targetIndex === -1) throw not-on-surface     // 被 compaction 遮蔽
           shadowedSeqs = surface.slice(targetIndex)        // 含目标本身
           surfaceStart = shadowedSeqs[0]; surfaceEnd = shadowedSeqs.at(-1)
```

易错点：**`shadowedSeqs` 必须从 target 一直到 surface 末尾**，`surfaceEnd` 是 surface 尾节点而不是 `targetSeq`。目标 token 只接受 `@<十进制>`（绝对 seq，按钮/装饰永远发这个）与 `<十进制>`（1 起 recency 下标），用**正则白名单**而非 `Number()`（会吞 `@1e3`/`@0x10`/裸 `@`，`src/rewind.ts:126-152`）。错误码固定四个：`no-user-messages`、`invalid-index`、`not-a-user-message`、`not-on-surface`（`src/rewind.ts:36-51`；文案映射 `src/index.ts:857-868`）。

### 2.4 Host 替你校验什么（本机，已确认）

```js
// app.asar:1859506-1859521 applySurface —— 裁剪语义
const start = surface.indexOf(replace.start), end = surface.indexOf(replace.end)
if (start < 0 || end < start) throw SessionFormatError(`... replacement range is not on the current surface`)
const shadowed = surface.slice(start, end + 1)
if (shadowed.some(seq => !sources.has(seq))) throw SessionFormatError(`... sourceEventSeqs omit a shadowed surface node`)
return [...surface.slice(0, start), event.seq, ...surface.slice(end + 1)]
```

| 规则 | 本机失败文案 |
| --- | --- |
| start/end 在当前 surface 上且 start 在前、且都 < 自身 seq | `start seq N not found in surface` / `is after end seq` / `must reference earlier events` |
| `sourceEventSeqs` 全覆盖被遮蔽节点，且非空/不重复/不引用 ≥ 自身 | `must include every shadowed surface node; missing …` / `must not be empty` / `must not contain duplicates` |
| `assistant/message` 不得带 `sourceEventSeqs`；surface 事件缺 `surfaceOp` | `… cannot carry sourceEventSeqs` / `… requires a surfaceOp marker` |

落地是 `splice(startIdx, endIdx-startIdx+1, event.seq)` 且 `replaceGeneration`/`contentGeneration` 各 +1（`app.asar:1875130-1875135`）——这两个计数器是宿主自己 prompt 重建/UI 刷新的信号，插件不要手动维护。

### 2.5 前置条件与失败模式（顺序照抄）

```ts
// src/index.ts:749-781（摘）
if (inflight.has(sessionId)) return { kind:'error', text: t('inflight') }     // 双击/双标签：第二次会打在被第一次遮蔽的节点上
inflight.add(sessionId)
if (agent.status !== 'idle') {
  agent.cancel({ kind: 'user' }, { keepInbox: true })                       // 保留 inbox，只砍未来
  if (!await waitForAgentIdle(agent, invocation.signal)) return { kind:'error', text: t('stopFailed') }
}
dropPendingSteering(agent)                                                  // 只清 inbox.nextStep；nextTurn 不动
plan = resolveOrError(agent.session.snapshotEvents(), agent.session.surface.nodes, rawTarget)   // abort 则报 cancelled
```

本机 API 已确认：`Agent.cancel(cause:{kind:'user'}, options?:{keepInbox?:boolean})`、`whenIdle():Promise<void>`、`Inbox{nextStep,nextTurn,remove(id)…}`。`waitForAgentIdle` 必须 race `whenIdle()`（`src/index.ts:694-714`，15s）：maintenance 阶段 `status` 也读 `idle`，而它在写 session，会和 append 抢。`nextTurn` 故意不清（QueueDock 有逐条编辑）。文件恢复与对话回退**互相独立**：快照格式更新导致恢复失败时，对话已回退成功，只在文案报告（`src/index.ts:812-820`）。

### 2.6 渲染层：Chat 必须补丁，Trajectory 全留

本机三处判据：`messageDefinition.match` 只对 `isAppendSurfaceEvent(event)` 的 `user/message` 建行（`app.asar:454564`）；`isVisibleChatNode` 只认 `visibility === "visible"`（`452916`）；`orderedVisibleChatNodes` 用它过滤 `order`（`453568`）。

推论（**已确认**）：marker（replace 副本）不会在 Chat 长出 user 气泡；被撤回的消息是 append-origin，**照旧渲染**，所以必须客户端改动。做法：wrap 已注册 `chat` view 的 `create()`，在进 builder 前把 `target..marker` 区间节点置 `visibility:'hidden'`（`src/client/visibility.ts:119-158,297-337`）；节点仍留在 store 里，composer 回填还能读到文本/图片，没有 DOM 级隐藏（`docs/compat/audit.md` U3）。隐藏后 `order`/locations/分组/Turn 导航自动重算（`app.asar:454095`），是官方路径。**Trajectory/Track 不过滤**：`trajectory-input-message` 的 `match` 对每个 `user/message` 都命中，不查 `surfaceOp`（`760382-760388`），所以撤回消息与 marker 都在（marker 以 `context` 行出现，label=你的 source kind）——审计视图天然正确。引擎命令行（`CommandNode`）若不想显示，参考在同一 wrapper 里一并 `hidden()`（`src/client/visibility.ts:319-337`）。

> 未确认（运行期）：本机 Chat 是否对 marker 生成任何边框行；按 `match` 判据不进 Chat，未在浏览器实测。

## 3. Composer 回填

```ts
// src/client/index.ts:210-219
const input = ctx.get('conversation')?.input
const scope = ctx.sessions.scope?.(sessionId as SessionId)
if (input === undefined || scope === undefined) return undefined
{ setDraft: d => input.for(scope).setDraft(d), focus: () => input.for(scope).focus() }   // 失败则退化到 [data-composer-input] + execCommand
```

本机语义（已确认）：`conversation.input.for(actx)` 需要**已保留的会话 scope**，否则抛 `"conversation.input.for requires a retained Session scope"`（`app.asar:476954-476960`）；`setDraft` = 整体替换草稿、换行切段、光标落尾、并入历史（`476198-476213`）；`focus()` 优先恢复 Lexical 选区（`476566-476572`）。

图片（`src/client/index.ts:242-298`）：`session.readAttachment({attachmentId,mediaType,bytes,width,height,name})` → `new File([bytes], name, {type})` → `conversation.createDrafts(sessionId, files)` → `conversation.input.for(scope).addAttachments(draftIds)`；`admitted === false`（composer busy）时 `releaseDraftAttachments?.(drafts)`。**先图后文**：`addAttachments` 不覆盖正在编辑的草稿，所以图片不受"空 composer 守卫"限制。`file` 块不还原（客户端无文件字节读取通道）。

**能否从任意 slot 组件调**：能，但必须自己拿 scope——`input.for()` 只认 `ctx.sessions.scope(sessionId)`，不认 id 字符串。参考仍把它包成 `setComposerText(sessionId,text)` 注入桥（`src/client/index.ts:306-313`），是为了共用"只填发生回退的那个主视图会话"的判断：`if (!isMainViewSession(session.sessionId)) return`（`src/client/portals.tsx:319-321`）——多窗口下必须有。

两个坑：**事件驱动，绝不扫历史**（先 `session.command()` 再 `waitForCommand(...isExecutedRewindCommand(node,seq) && !known.has(node.seq))`，执行前采样排除旧节点，`260-357`）；**空 composer 守卫** `composerText().trim() !== '' 则 return`（`346-350`）。文本取自 chat snapshot 的 `user`/`steering` 节点，读 `nodes.values()`（含已隐藏节点）而**不是 `order`**（`src/client/hidden.ts:50-60,116-131`）。

## 4. 文件恢复经验

**为什么绕开 fs 服务**（`src/index.ts:804-812` 原文）：restore 用裸 `node:fs`（`unlink`/`writeFile`/`copyFile`），"because it must also reach paths the service would refuse as stale/absent. That is safe only because the action set is the closed `planRestore`-derived one"。安全边界 = 闭集路径 + `lstat` 拒绝符号链接/硬链接（`nlink>1`）+ 目录 realpath pin（`SECURITY.md:104-120`、`docs/format.md` 的 `parent`），不是服务鉴权。

**`syncRestoreObservations`（必抄）**（`src/index.ts:663-683`，理由 `636-656`）：

```ts
ctx.emit('fs/observed', target, { kind: 'absent' }, { agent })                              // outcome.deleted
ctx.emit('fs/observed', target, { kind: 'present', version: (await fs.stat(target)).version }, { agent })   // restored
```

恢复用 `node:fs` 写/删，**fs 观察策略看不见**；不同步则同会话下次写这些文件按"回退前"的陈旧 observation 判成 `replaceIfVersion`，`fs-local` 抛 `FS_STALE_VERSION`（"file no longer exists — re-read the file, then retry"），而 agent 其实是合法重建。同步后：删除的变 `{kind:'absent'}`（下次 `createIfAbsent`），还原的取新 `version`（下次按当前版本 CAS）；**外部修改仍照常触发 stale 守卫**。本机 `fs/observed` 存在，签名 `(target, observation, actor)`。

**存储布局与上限**（`docs/format.md`、`src/snapshot.ts:46-93,1109-1112`）：根 = `<dsh home>/rewind-snapshots/`（`resolveDshHome()`：`config.dshHome` > `$DSH_HOME` > `~/.dsh`）；`<sessionId>/{store,format,<anchorSeq>/<base>.{json,before},.pending/,rescue/,journal-*.json}`。每文件上限 **8 MiB**（`0`=取消），每会话保留最新 **100** 个锚点组；超限文件**不记录**（不是截断）且文案点名；相同内容存 `ref` 链接去重；恢复是对账式（重复回退幂等）；`store` 版本更高 → `UnknownStoreVersionError` → 文件恢复整体失败关闭、对话回退照常（`src/index.ts:812-820`，ADR-10）。

**捕获钩子**：用 **`tools/execute`（around-dispatch）+ `tools/post-execute`**（`src/index.ts:1432-1462`），锚点 = 提交时最近一条 `user/message` seq（`anchorSeqOf`，`264-277`）；只管 `TRACKED_TOOLS = new Set(['write','edit'])`（`133`）；`tools/result` 兜底清孤儿 pending（`1464-1478`）。**外部改动**由 `session/event` 的 `user/message` 边界重查覆盖（`1368-1399`；`inflight` 时跳过该 pass，因为 append 同步派发，会和 `restoreAfter` 的写入撞出撕裂状态）。**不用 `fs/write-intent`/`fs/edit-intent`**。

**与现有插件的关键差异**：`dsh-session-rewind` 现用 `fs/write-intent`/`fs/edit-intent` + `tools/pre-execute`，归档键是 **turn 号**（`src/plugin.js:288,342-359`）。就地回退的边界是**用户消息 seq**，必须把归档键换成/加上 `anchorSeq`，否则"回退到第 N 条消息"映射不出"恢复哪些文件"。建议保留现有 archive，只加 `anchorSeq` 字段。

## 5. 版本守卫：抄什么、跳什么

| 守卫 | 参考做法 | 我们 |
| --- | --- | --- |
| 装载准入 `engines.dsh` | `">=0.2.2-alpha.2 <0.3.0-0"`（`package.json:26`） | **不抄**：本机 0.2.1-rc.5 低于下界；DSH 读 `engines.dsh`（无则读 peers）按 `includePrerelease` 拒绝（本机 manifest 校验带 `requirements` 字段）。现状不声明即可。 |
| 插件 store 格式号 / 会话格式迁移 | `CURRENT_STORE_VERSION=2`，更高版本 → `UnknownStoreVersionError` fail-closed；`setFormatVersion`+`reconcileFormatVersion` 在格式变化时丢弃旧快照（seq 会错位），且 `assertKnownStoreVersion` 必须先于对账（`src/index.ts:1330-1345`，顺序有讲究） | 抄（沿用自带归档格式时）；只做对话回退可跳过 |
| subagent 会话 | 单一谓词 `isSubagentSession`（`src/index.ts:146`）跳过捕获/重查/cleanup；客户端 `isRewindInertSession`（`src/client/portals.tsx:500-502`） | 抄。本机依据：subagent 身份的通用 Session RPC 被拒（`session/agent-busy`），命令目录本身返回空 |
| 命令被占 / 私有 seam | 注册失败只降级该名字（`src/index.ts:1273-1310`）；visibility 改 `uiConversation.views` 里 `target==='chat'` 的 `definition.create`，先形状检查、失败只记日志、卸载还原并按 `retainedBy` 重建（`src/client/visibility.ts:119-182`） | 抄。跨包类型全部本地结构化声明 + `ctx.get()` 懒解析，**不要** import 别家 UI 包的运行时代码 |
| 设置卡片 / 快照自动清理 / 旧 marker 迁移命令 | `plugins.bundle.config`、`snapshot-auto-cleanup`、`/dsh-rewind-fix` | **跳过**（产品面/历史包袱） |

## 6. 本机 0.2.1-rc.5 与参考假设的冲突

| 项 | 参考（0.2.2-alpha.2） | 本机（已确认） | 影响 |
| --- | --- | --- | --- |
| `conversation.createDrafts` | `(sessionId, files, uploadImages)` 3 参（`src/client/index.ts:287`） | `(sessionId, files)` 2 参（`app.asar:465912`） | 传 3 个不报错，第 3 个被忽略；图/文件靠 `file.type` 判定 |
| surface 契约 | `SurfaceIntent` / `{op:'replace',startSeq,endSeq}` / 覆盖校验 | 同形，`applySurface`、`replaceRange`、`assertSourceEventReferences` 都在（`app.asar:1859506,1874978,1875028`） | 无差异，可照写 |
| `MessageSourceMap` | merge 扩展、无 `plugin` 兜底 | 同（止于 `webhook`） | 必须 `declare module`；运行时宽容 |
| Chat 隐藏撤施行 | 需 wrap builder（U3 未修） | 仍需：`isVisibleChatNode` 只认 `visibility==='visible'`，Chat 只按 append-origin 建行 | **必须实现客户端隐藏** |
| 查询通道 | Connection RPC（`connection.rpc.handle`） | `connection` 在，但现有插件已有 same-origin 路由 | 复用 `/api/session-rewind.*`，少一个注入 |
| slot props / `commandUi.decorate` | `{sessionId}` / popupSelect spec | 同（`app.asar:500347,500364,459984`） | 无差异 |

## 7. 落地顺序

1. **Host 纯函数** `src/lib/rewind.js`：`isHumanUserMessageEvent` / `listRewindCandidates(events,surface,100)` / `planRewind` / `parseRewindTarget` + 四个错误码；先写 `node:test` 单测。
2. **Host 命令与执行体**：`rewind` + `undo` 别名 + 带 `input.hint` 的引擎命令（成功回 `sourceEventSeq`）；执行顺序 = in-flight → `cancel`+`whenIdle()` race → `dropPendingSteering` → 重新 plan → append →（可选）文件恢复 → 文案。
3. **Host 路由**：现有 `lib/route.js` 加 `candidates` 与 `plan`（返回 `{targetSeq, files:[{path,action}], backupOff}`），沿用 `trustedHosts`。
4. **Client 选择器**：header 入口列表 + `commandUi.decorate`（`package.json` 的 `dsh.client.inject` 需加 `@deepseek-ai/dsh-client-ui-commands`）→ 发引擎命令。
5. **Client 行内按钮**：注册 header slot 的只门户桥 + `actionsContainerOf` + 三路刷新合并。
6. **Client hide 层**：wrap `chat` builder 的 `create`，按 cut `{target,marker}` 置 `visibility:'hidden'`，卸载还原并 `rebuild()`。
7. **Client 回填**：`input.for(scope).setDraft` + `focus()`，图片 `readAttachment`→`createDrafts`→`addAttachments`；守卫主视图 + 空 composer。
8. **验证四连**：裸 `/rewind` 开 picker；点 ↶ 选"仅对话"→ 旧行从 Chat 消失、Trajectory 仍在、composer 有原文；运行中点 ↶ → 取消后回退；回退后让模型重建被删文件 → **不应**出现 `FS_STALE_VERSION`（§4 的目的）。
