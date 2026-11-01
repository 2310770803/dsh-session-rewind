# 发布与插件市场索引

本文说明三件事：这份仓库里的 `index.json` 是什么、用户怎么在 DSH 里把索引源加进来、
以及维护者如何把它发出去。所有路径都以本机实测为准（DSH Web / desktop profile，
DSH `0.2.1-rc.5`，Windows）。

## 1. 这个插件怎么分发

npm 上没有发布这个包（本机 `npm whoami` 返回 401，没有 npm 凭据），所以它走的是
**format-1 插件市场索引 + Git 源**：

- `index.json` 是一份格式 1 的插件市场索引，只描述 `dsh-session-rewind` 一个插件；
- 它的版本条目里写的是 `source: { type: "git", url, commit }`，**commit 固定到 40 位 SHA**，
  不是分支；
- DSH 的 **插件 → 发现（Discover）** 标签页和 `plugin_market` 智能体工具都会读它；
- 索引本身是仓库根目录的一份 ~2 KB JSON，通过 GitHub raw 文件（或钉到标签的 jsDelivr CDN）分发，
  所以安装时既不需要 npm，也不需要本地构建。

用户要添加的索引源就是：

```
https://raw.githubusercontent.com/2310770803/dsh-session-rewind/main/index.json
```

> **为什么首选 raw 而不是 jsDelivr。** 实测：`…@v1.1.1/index.json` 立刻是新的，但
> `…@main/index.json` 在 jsDelivr 上会继续返回旧版本（branch 引用缓存最长 12 小时，
> 连 `purge.jsdelivr.net` 也立刻清不掉）——用户会看到过期条目。raw 每次都是最新的，
> 一个 ~2 KB 的 JSON 在 0.2 s 内返回，远低于宿主给索引源的 **15 秒**（`fetchTimeoutMs` 默认 15000）。
> 如果网络访问 raw 不稳定，可以改用 CDN 形式：
>
> ```
> https://cdn.jsdelivr.net/gh/2310770803/dsh-session-rewind@v1.1.1/index.json
> ```
>
> 注意这是**钉到标签**的，换版本要改 URL；`@main` 形式则会滞后。

## 2. 怎么加索引源

### 本机已经加好了

这台机器（profile `desktop`）的 `cordis.patch.yml` 末尾已经写入下面的条目，并且已经通过
一次 profile 重组生效（写入前备份在 `cordis.patch.yml.rewind-backup`）。所以只需要打开
**插件 → 发现**，在搜索框里搜 `rewind` 或 `会话回退`，条目里点安装即可。

> 「发现」标签页是按需抓取的：只有在它被打开时才会去拉索引源，因此加完索引源后**要打开
> 一次「发现」页**才会看到条目；不需要重启 DSH。

### 换一台机器时手动加

1. 打开左侧 **插件 → 发现（Discover）**。
2. 点 **索引源（Index sources）** → **添加索引源**，粘贴上面推荐的索引源 URL。
3. 搜索 `rewind` 或 `会话回退`，打开条目，点 **安装**。

如果这台机器上的「发现」标签页不存在，说明实验性插件市场没启用。它随 DSH 一起发布但
默认关闭：

- **插件** 页面 → **实验性插件** 旁的 **更多** → 启用 **自定义插件市场**
  （包名 `@deepseek-ai/dsh-experimental-plugin-market-bundle`）；
- 或者手动在 profile 的 `dsh.profile.bundles` 里加上这个包名后重启。

启用后会出现 **已安装 / 发现** 两个标签页；**发现** 用来添加索引源并安装其中的条目。
禁用这个组合包会移除「发现」和 `plugin_market` 工具，但**已保存的索引源会留在
profile 里**，不会丢。

### 索引源到底存在哪里（本机实测）

这是本文最重要的结论，因为「索引源」既不在 `~/.dsh/storages/`，也不在
`.dsh-market/` 里。

**它存在当前 profile 的 Cordis patch 文件：**

```
C:\Users\23107\.dsh\profiles\desktop\cordis.patch.yml
```

形式是顶层 YAML 数组里的一个**按 id 覆盖的条目**，行 id 固定为 `plugin-market`
（Host 服务 `@deepseek-ai/dsh-plugin-market` 的 Loader 条目 id），配置键是 `indexes`：

```yaml
- id: plugin-market
  config:
    indexes:
      - https://raw.githubusercontent.com/2310770803/dsh-session-rewind/main/index.json
```

证据链（全部来自运行中的 DSH 与本机 profile，而不是文档推测）：

1. **运行的是哪个 profile。** 监听 GUI 端口 64031 的宿主进程命令行是
   `... dsh-desktop-host/lib/index.js "E:\DeepSeek Harness\resources\app.asar\dsh"
   "C:\Users\23107\.dsh\profiles\desktop" ...`，即当前 profile 目录确为
   `C:\Users\23107\.dsh\profiles\desktop`。
2. **服务端字段。** `@deepseek-ai/dsh-plugin-market/lib/index.js`（在
   `resources/app.asar` 内）里写着：
   ```js
   static Config = z.object({
     indexes: z.array(z.string().pattern(/^https?:\/\/\S+$/u)).default([]).volatile(),
     fetchTimeoutMs: z.natural().default(15e3),
     maxBytes: z.natural().default(128 * 1024 * 1024),
     cacheTtlMs: z.natural().default(6e5),
   })
   ```
   `indexes` 是 **volatile** 字段：改它不会重挂服务，只触发 `loader/volatile-update`，
   随后广播 `plugin-market/changed`。
3. **写入路径。** 同一个文件里的 `setIndexes(urls)` 在规范化 URL 之后调用：
   ```js
   await settings.update(this.entryId, { indexes: normalized })
   ```
   其中 `entryId = ctx.fiber.entry?.options.id`，也就是上面那个行 id `plugin-market`。
4. **`settings.update` 落到哪。** `@deepseek-ai/dsh-settings` 的 README 明确写
   「更改通过当前 profile 的 Cordis patch 持久化」；`@deepseek-ai/dsh-config-editor`
   同样写「编辑写入当前 profile patch」，且保留其余 YAML 注释。profile patch 的文件名
   由 `@deepseek-ai/dsh-app-boot` 的常量 `PROFILE_PATCH_FILENAME = "cordis.patch.yml"`
   决定。
5. **服务确实挂载了。** 运行中的 Host 服务目录里能看到 `pluginMarket`：
   *"Fetches, validates, and caches configured market indexes; annotates entries with
   the profile's installation facts."* 说明本机「发现」可用。
6. **今天还没有任何索引源。** 在 `cordis.patch.yml` 里 grep `plugin-market` /
   `pluginMarket` 没有任何命中——也就是说这份清单现在是空的，需要用户（或脚本）添加。
   该行即使不存在也不影响服务挂载：它是 bundle patch 插入的行，配置覆盖层只是可选覆盖。
7. **什么不是它。** 下面这些都被排除：
   - `~/.dsh/storages/`：storage-hub 的领域存储（`workspace.json`、`schedule.json` 等），
     没有市场数据；
   - `~/.dsh/profiles/desktop/.dsh-market/`：`dshmarket` 这个社区插件自己的缓存/
     `state.json`（`{"disabled":[],"groups":{},"channel":"stable",…}`），不是官方索引源；
   - `~/.dsh/dsh-market/printed-build-keys.json`：无关。

**推荐用 UI 添加**，因为 `settings.update` 是即时生效的（volatile），不需要重启；
手工编辑 `cordis.patch.yml` 只在 DSH 关闭时最安全，改完需要重启或触发 profile 重载
才会生效。两个窗口同时编辑索引源会互相覆盖（服务端是「后写覆盖整份列表」）。

## 3. 维护者：生成和校验索引

```sh
node scripts/build-index.mjs                    # 按 HEAD 生成 index.json
node scripts/build-index.mjs --commit <sha>     # 固定到指定 commit
node scripts/build-index.mjs --check            # 校验 index.json 是否过期（过期则退出码 1）
node scripts/build-index.mjs --dry-run          # 只把文档打到 stdout，不写文件
```

要点：

- 只依赖 Node.js 标准库，不需要 `npm install`，不需要 TypeScript，不需要构建。
- 输出是确定性的（两空格缩进 + 结尾换行），所以 `--check` 是比较字节，而不是比较语义。
- `--commit` 必须是 40 位小写十六进制 SHA；不传时取 `git rev-parse HEAD`。
- `publishTimestamp` 取该 commit 的作者时间（Git 源最接近「发布时间」的东西）。
  如果这个 commit 不在本地对象库里（浅克隆、或仓库还没初始化就要预览），
  用标准的 `SOURCE_DATE_EPOCH=<unix 秒>` 覆盖，保证仍然确定性。
- 生成前会自检格式 1 的关键规则（`format`、`en` 标题、分类 id 已声明、SemVer、
  git commit 形态、https URL 等），避免把坏文档提交进去。
- 索引的 `icon` 指向 `https://raw.githubusercontent.com/.../main/icon.svg`
  （仓库没有 180×180 PNG；format 1 的 icon 只要求是 https 或索引同源的 URL 引用）。
- 索引级 `title/description` 描述的是「这份索引」，插件级 `title/description`
  来自 `locale/en.json`、`locale/zh.json` 的 `meta`。

### format 1 允许哪些字段

宿主用 `@deepseek-ai/dsh-plugin-market-index` 校验；下面这些是它实际接受的形状
（未列出的字段会被**静默丢弃**，所以「截图」不在这里）：

- 索引：`format: 1`、`title`（本地化文本，必须含 `en`）、`description?`、
  `metadata.categories / labels / sortKeys?`、`plugins[]`。
- 插件：`name`（npm 包名形态）、`title?`、`description?`、`icon?`、`author?`、
  `homepage?`、`repository { url, directory? }?`、
  `metadata { category?, keywords?, labels?, sortKeys? }`、`versions[]`（非空）。
- 版本：`version`（精确 SemVer）、`publishTimestamp`（Unix 秒整数）、
  `source`、`engines { dsh? }`。
- `source`：`{ type: "npm", registry? }` 或
  `{ type: "git", url, commit, path? }`。git 的 `url` 必须是规范化 https 地址、
  至少两段路径、不能是 tarball；`commit` 必须是 40 位小写十六进制；
  `path` 是仓库内的子目录。
- `icon`：https 绝对 URL、数据 URL（≤ 32 KiB）或索引同源 URL；相对引用按索引 URL 解析。
- 安装参数由宿主拼：git 源会变成
  `git+https://github.com/2310770803/dsh-session-rewind.git#<commit>`。

`--check` 在 CI 里跑（`.github/workflows/ci.yml`），也在发布工作流里跑。

## 4. 发布流程

当前版本是 `1.1.1`。一次发布按下面的顺序做，**两个提交一次 push**：

1. **改版本、写更新日志。** 把 `package.json` 的 `version` 改成 `x.y.z`，并在
   `CHANGELOG.md` 里写一个 `## [x.y.z] - YYYY-MM-DD` 小节（发布工作流会抽取它当
   Release 正文，缺了会直接失败）。
2. **提交代码（commit X）。** 这一步不包含 `index.json`。
3. **生成索引。**
   ```sh
   node scripts/build-index.mjs        # 默认按 HEAD = X 固定
   node scripts/build-index.mjs --check
   ```
4. **提交 `index.json`（commit Y）。** 它固定的是 X：索引不能把自己所在的那个提交
   写进去（否则文件内容要包含自己的 hash）。
5. **一次 push，再打标签。**
   ```sh
   git push origin main          # 一次 push 带 X 和 Y，CI 只看 Y，直接是绿的
   git tag v1.1.1
   git push origin v1.1.1
   ```
   > 如果分成两次 push，push X 时 CI 会短暂报红：`--check` 要求
   > `index.json` 与 `package.json` 一致，而 X 还没有新索引。这是预期行为。

打标签后 `.github/workflows/publish.yml` 会自动：

- 校验标签 `v1.1.1` 与 `package.json` 的 `version` 一致，并且 **tag 提交就是
  `main` 当前指向的提交**（因为下一步要往 `main` 推索引；发布一律从 `main` HEAD 切）；
- 再跑三个测试套件；
- 按 tag 提交重新生成 `index.json`（固定到该提交），并用 `--check` 证明它就是生成器的输出；
- 把刷新后的 `index.json` 提交回 `main` —— 这一步才是让分支索引真正更新的动作；
- 用 `CHANGELOG.md` 的对应小节创建 GitHub Release，并附上两个**文件名不带版本号**的资产：
  `index.json` 与 `dsh-session-rewind.tgz`（`npm pack` 离线打包，无依赖、无构建）。

`workflow_dispatch` 是不发版的干跑：同样的检查与索引重建，但不提交、不建 Release。

> 由 `GITHUB_TOKEN` 推送的提交**不会**再触发一轮 CI（GitHub 防递归的规则），所以
> 发布工作流推回 `main` 的那个 index 提交不会跑 `ci.yml`。这不是漏洞：工作流在推送**之前**
> 已经跑过 `--check`，推上去的文件就是被证明过的那个。

### 本仓库的现状（2026-11-01 实测）

- 最新发布是 `v1.1.1`（上一版 `v1.1.0`）：<https://github.com/2310770803/dsh-session-rewind/releases>；
  Release 资产是 `index.json`（sha256 `446b1a31…70b4`）与 `dsh-session-rewind.tgz`；
- 发布工作流把索引提交推回 `main`（`bb347da`，提交信息 `chore(index): regenerate for v1.1.1`），
  索引固定到 tag 提交 `d10b1f717c35290bd23e082cdf6304a9f913369e`（`package.json` 版本 `1.1.1`）；
- 两次 Release run（`41265021487` 对应 v1.1.0、`41265207164` 对应 v1.1.1）与对应的
  CI run 都是 success，步骤包含测试、重新生成、`--check`、建 Release、上传资产；
- 索引用宿主校验器 `parseMarketIndex` 解析通过，安装参数为
  `git+https://github.com/2310770803/dsh-session-rewind.git#d10b1f7…`；
- **缓存是分层的**：raw 侧也有 CDN 缓存（通常几分钟，本次实测是立即可见）；jsDelivr 的 gh
  分支缓存 `s-maxage` 是 12 小时，`purge.jsdelivr.net` 也不一定立刻清掉（实测 `@main`
  仍返回旧文档，而 `@v1.1.1` 立刻是新的）。所以本机 profile 配的是 raw 地址；
  用 CDN 就钉到标签。

### 发布之后要确认的事

1. 先确认 raw 已经是最新（本机 profile 配的就是它）：
   ```sh
   curl -s https://raw.githubusercontent.com/2310770803/dsh-session-rewind/main/index.json
   ```
   看 `plugins[0].versions[0].source.commit` 是否等于新 tag 的提交。用 CDN 索引源时还要
   轮询 `https://cdn.jsdelivr.net/gh/2310770803/dsh-session-rewind@<tag>/index.json`；
   `@main` 形式会滞后，必要时 purge 后继续等，别把旧文档当成新文档。
2. DSH 自己还有 **10 分钟**的索引缓存（`cacheTtlMs` 默认 `600000`）。在「发现」里
   重新打开插件市场或刷新页面即可；带 `refresh` 的查询会绕过缓存。
3. 装一遍验证：在「发现」里点安装，或者直接给 `plugin_manager`：
   ```js
   { action: 'install_bundle', target: 'git+https://github.com/2310770803/dsh-session-rewind.git#<commit>' }
   ```

## 5. 已知空缺与限制

- **不在 npm 上。** 没有 npm 凭据，发布工作流里刻意没有 `npm publish`；
  分发路径只有 Git 源（和 Release 上的 tarball）。
- **索引没有签名。** 索引里的名称、版本、来源都是「市场声明」；真正安装的代码由
  安装时的 manifest 与 commit 决定。请把索引源限制在自己信任的仓库。
- **format 1 没有截图层。** 截图是 `dshmarket` 那套社区目录（awesome-dsh-plugin /
  dshmarket.com）的概念（作者提供、必须托管在 GitHub、最多 6 张），不会出现在这份
  format-1 索引里；本索引只带一个 `icon`。
- **`dshmarket` 不读这个索引源。** 它是另一个可视化插件市场，自己有一套社区目录；
  要出现在那边需要单独向它的目录提交条目，不在本次范围内。本索引服务的是 DSH 自带的
  **插件 → 发现 → 索引源**（以及 `plugin_market` 工具）。
- **没有声明 `engines.dsh`。** `package.json` 目前只有 `engines.node`，所以生成的索引
  也不写 DSH 版本区间，市场不会按 DSH 版本拦截安装。等 `package.json` 开始声明
  `engines.dsh`（或锁步的 `@deepseek-ai/dsh-*` peer），重新生成即可，脚本会自动带上。
- **一个索引只能被一个「发现」页消费。** 索引源按 URL 去重；重复添加同一个 URL 会被拒绝。
- **重定向会被拒绝。** 索引必须能以配置的最终 URL 直接访问。
