# T4-A｜0.1.7-rc.1 → 0.2.0-rc.1 API 面独立差分复核

- 复核人：reviewer（T4），独立重跑，不采信 T1/T2 结论
- 基线提交：`642bb8e`（0.1.5），工作树 = T1 改动后
- 复核时间：本次会话
- 结论：**未发现破坏性 API 漂移（静态面与动态面均无）**；本包的 19 个导入符号、12 个 `ctx.get` 服务键、6 个事件名、客户端 4 个服务在 0.2.0-rc.1 下全部存在且契约一致。
- 分级：阻断 0 条 / 应修 0 条 / 提示 3 条（均为**既有**问题或文档口径问题，非本次升级引入）。
- **补充（T5 交叉复核）**：本次迭代真正的阻断缺陷不在 API 面，而在**模块解析路由**面——`lib/agent-instructions-preset.js` 的裸导入 `@deepseek-ai/dsh-llm` 既被 tsdown 当 external、又没写进 `peerDependencies`，DSH 的 linked 层因而不接管它。我已独立复核该机制与修法（见 [第 6 节](#6-t5-交叉复核裸导入与-linked-层路由阻断缺陷独立复核)）。**这恰好是"tsc 0 错误 ≠ 运行时可用"的最强例证，也正是本次 A 部分被要求重点覆盖的那一类。**

---

## 0. 复核基线（这些事实我自己验证过，不是照抄）

| 事实 | 我的验证方式 | 结果 |
|---|---|---|
| CLI 运行版本 | `dsh --version` | `0.2.0-rc.1` |
| 桌面 App 运行版本 | `Resources/runtime/primary-runtime/runtime.json` | `desktopVersion: 0.2.0-rc.1` |
| **GUI 19387 端口实际加载的 DSH 是哪一个** | `lsof -nP -iTCP:19387 -sTCP:LISTEN` → pid 78207 → `ps` 显示其入口是 `app.asar/dsh/node_modules/@deepseek-ai/dsh-desktop-host/lib/index.js` | 运行的是 **app.asar 内置的 DSH**，不是 `~/.local/lib/node_modules` 那一份 |
| 两份安装是否同一构建（关键：否则我的差分对象就错了） | 解 asar 取每个 `package.json` 版本 + 对 17 个关键运行文件做 sha256 对比 | asar 290 个包 / 本地 288 个包，**多出的只有 `dsh` 与 `dsh-desktop-host`**；其余 288 个版本号逐个相同；17/17 关键文件 **sha256 完全相同**（见附录 A） |
| cordis / loader 是否同一版本 | 两侧 `package.json` | `cordis@4.0.4`、`cordis-plugin-loader@1.0.5`、`cordis-plugin-include@1.0.9`、`cordis-plugin-group@1.0.4`、`schemastery@3.18.4`，**两侧一致** |
| npm 上的版本情况 | `npm view @deepseek-ai/dsh dist-tags versions` | `latest = 0.1.7-rc.2`、`next = 0.2.0-rc.1`，最高版本 = `0.2.0-rc.1`，**无 0.2.0 稳定版** |
| 安装闸门对当前 package.json 的真实判定 | 直接 import `evaluatePluginCompatibility`（app-boot 有导出）跑真函数 | 工作树 → `undefined`（PASS）；`git show HEAD:package.json` → **REJECT**（清单含 `@deepseek-ai/dsh-client-runtime: ^0.1.1-rc.2`） |

> 关于 npm dist-tag：`latest` 仍指向 `0.1.7-rc.2`。这一点对 peer 范围有实际意义——新范围 `^0.1.7-alpha.2 || ^0.2.0-rc.1` **同时覆盖** `0.1.7-rc.2`（走 `latest` 装的用户）与 `0.2.0-rc.1`/`0.2.0`（走 `next` 与将来的稳定版）。用真 semver 跑过（附录 B）。

---

## 1. 静态类型面差分（.d.ts 全量比对）

方法：把两版每个包的**全部 `.d.ts`**（排除 `package.json`）拼成文本后 diff；再对逐符号做声明块级比对。

```
IDENTICAL  dsh-skill        ← SkillProvider / SkillProviderControl / SkillCandidate / SkillDefinition
IDENTICAL  dsh-agent        ← Agent / PreStepDecision
IDENTICAL  dsh-fs           ← FileSystem / FsInfo / FsTarget / FsVersion
IDENTICAL  dsh-config-editor← entries() / configuration() / edit()
IDENTICAL  dsh-agent-preset ← PRESET_MODULE 目标包
IDENTICAL  dsh-settings     ← configure(presentation, owner?)
IDENTICAL  dsh-hmr
IDENTICAL  dsh-host-webserver
IDENTICAL  dsh-client-connection / dsh-client-modules / dsh-client-resources / dsh-client-store
IDENTICAL  dsh-client-ui-slots / dsh-home-paths / dsh-base / dsh-agent-instructions
DIFFERS    dsh-llm(67) dsh-session(104) dsh-tools(7) dsh-agent-preset-registry(13)
           dsh-plugin-manager(7) dsh-app-boot(43) dsh-client-locale(2) dsh-skill-filesystem(433)
```

逐符号复核（本包实际导入的 19 个符号，签名级）：

> `dsh-skill-filesystem(433)` 是假差异：新版 tarball 里多了 `lib/node_modules/chokidar/*.d.ts`、`readdirp/index.d.ts` 三个第三方声明（`diff -rq` 已确认该包 `lib/index.js` 两版**逐字节相同**）。其余 DIFFERS 项逐条见下。

| 包 | 符号 | 结论 |
|---|---|---|
| dsh-skill | `SkillProvider` `SkillProviderControl` `SkillCandidate` `SkillDefinition` | 声明块 **逐字节相同** |
| dsh-agent | `Agent` `PreStepDecision` | **相同**（`PreStepDecision` 的 `startsRequestSeries?: true` 两版都有） |
| dsh-llm | `createUserMessage`（值） `Message` `UserMessage` | **相同** |
| dsh-session | `Session` `UserMessage`(转自 dsh-llm) | `Session` 仅**新增** `toolHistory(): ToolHistory` + 2 个 private 字段；`UserMessage` 定义相同 |
| dsh-tools | `ToolExecution` `ToolExecutionResult` `ToolExecutionToken` | **相同**（差异只在 `ask.displayReason?` 新增字段） |
| dsh-fs | `FileSystem` `FsInfo` `FsTarget` `FsVersion` | **相同** |
| cordis | `Context` `Service` | 同版本 4.0.4 |
| cordis-plugin-loader | `Entry` | 同版本 1.0.5 |

**存在的删除项（全部确认本包未使用）**：

| 删除/变更 | 位置 | 本包是否使用 |
|---|---|---|
| `modeSelectionEnabled` 从 registry `Config` 移除 | `dsh-agent-preset-registry@0.1.7-rc.1 lib/types/index.d.ts:27,31` → 0.2.0-rc.1 无 | 否（`grep -rn modeSelectionEnabled src/ scripts/` 无命中） |
| `generateConfigSchema(binName, …)` → `generateConfigSchema(…)` | `dsh-app-boot@0.1.7-rc.1 lib/types/config-schema/index.d.ts:19` vs 0.2.0-rc.1 同文件 `:18` | 否 |
| `skippedProfileBundles()` 移除，改为 `SkippedBundle` + `reportSkippedBundles()` | `dsh-app-boot@0.1.7-rc.1 lib/types/profile.d.ts:168` vs 0.2.0-rc.1 `lib/types/profile.d.ts:80,91` | 否 |
| `remoteExportList()` 返回结构去掉 `modeSelectionEnabled` | `dsh-agent-preset-registry/lib/index.js`（0.2.0-rc.1:593-597） | 否（本包只调 `compositionInventory()` / `list()`） |

**纯新增项（非破坏）**：`dsh-llm` 的 `ToolUpdate`/`ToolHistory`/`projectToolUpdates`/`ACCOUNT_QUOTA_EXCEEDED_CODE`；`dsh-session` 的 `ToolCallRecovery`/`ToolHistoryProjection`/`tool-history.d.ts`；`dsh-tools` 的 `ask.displayReason?`；`dsh-plugin-manager` 的 `treeAlive()`；`dsh-client-locale` 的 `'workspace.defaultName'` 字典键 + CSS 微调。

---

## 2. 动态契约差分（重点：tsc 抓不到的那一层）

### 2.1 为什么这一层必须手工核对——先给出机制证据

`ctx.get(...)` 在 cordis 4.0.4 里是**无类型**的：

```
~/.local/lib/node_modules/@deepseek-ai/dsh/node_modules/@deepseek-ai/cordis/lib/types/reflect.d.ts:122
    get(name: string, strict?: boolean): any;
```

本包 12 处服务读取全部写成 `ctx.get('<name>') as XxxLike | undefined`（结构性自造接口），**`tsc --noEmit` 对键名、方法名、返回结构 0 信号**。因此下面每一项都是必须手工核对的。

### 2.2 逐项核对结果

| # | 契约 | 本包位置 | 0.2.0-rc.1 实际 | 结论 |
|---|---|---|---|---|
| 1 | `ctx.get('configEditor')` → `entries/configuration/edit` | `src/core/composition.ts:124`、`src/index.ts:110` | `dsh-config-editor/lib/index.js` `super(ownerContext,"configEditor")`；三方法同名同签名；**`edit()` 源码两版逐字节相同**（仍 `hmr.runExclusive(run)`） | ✅ 一致；`configuration()` 的 `inherited` 解析**语义变好**（0.1.7 恒走 `inherited()`，0.2.0 无覆盖时用 `composed`），非破坏 |
| 2 | `ctx.get('agentPresets')` → `compositionInventory()` `list()` | `src/core/composition.ts:125` | `AgentPresetRegistry.compositionInventory()` **方法体两版逐字节相同**，返回 `{id,name?,description?,isDefault,broken?,rows}` 数组；`AgentPresetComposition` 类型逐字节相同 | ✅ 一致 |
| 3 | `settings.configure({auto:false}, ctx.fiber)` | `src/index.ts:103` | `dsh-settings/lib/index.js:370` `configure(presentation, owner = this.ctx.fiber)`；runtime 与 types **全文件相同** | ✅ 一致（坑 6 的写法仍然正确） |
| 4 | `ctx.get('hmr').executing.exit` | `src/core/hmr.ts:39-44` | `dsh-hmr/lib/index.js` **两版逐字节相同**；`executing` 仍是实例上的公开 `AsyncLocalStorage` | ✅ 一致（坑 5 的逃生舱仍可用） |
| 5 | `ctx.get('webServer').register({kind:'exact',path,handler})` | `src/core/rpc.ts:83,101` | `dsh-host-webserver` types+lib **全文件相同**；`register(route: WebRoute): () => void`，`kind: 'exact' \| 'prefix'` | ✅ 一致 |
| 6 | `ctx.get('fs')`（provider 子集） | `skill-filesystem/preset.ts:47`、`agent-instructions/preset.ts:174` | `dsh-fs` types+lib **全文件相同** | ✅ 一致 |
| 7 | `ctx.get('dshHomePath')` → function | `skill-filesystem/provider.ts:258,276` | `dsh-app-boot/lib/index.js:4071` `ctx.provide("dshHomePath", dshHomePath)`（旧版 `:4054` 同句） | ✅ 一致 |
| 8 | `ctx.get('skills').registerProvider(control => provider)` + `control.invalidate()` | `skill-filesystem/preset.ts:64,54` | `dsh-skill` types+lib **全文件相同**；`SkillProviderControl{signal,invalidate}` 声明块逐字节相同 | ✅ 一致 |
| 9 | `fs/observed (target, observation, actor.name ∈ {write,edit})` | `skill-filesystem/preset.ts:74-81` | 事件仍在 `dsh-tool-fs` 以 `(target, obs, exec)` 三参发出；工具名 `write`/`edit` 两版相同；内建 `dsh-skill-filesystem` 的 `mutationToolName()`（`lib/index.js:564-568`）判定集合 = `{edit,write}`，**本包移植的判定与内建完全一致** | ✅ 一致 |
| 10 | `session/event (session, event)` | `agent-instructions/preset.ts:355` | `dsh-session/lib/index.js:1465` `callbackArgs = [this, event]`（旧版 `:1350` 同句）；`Session.snapshotEvents()` 仍在（`lib/types/index.d.ts:193`） | ✅ 一致（两版派发代码片段逐字节相同） |
| 11 | `agent/pre-step ({agent,messages,step,signal}, next)` | `agent-instructions/preset.ts:372-375` | `dsh-agent-loop/lib/index.js:911` waterfall 载荷 `{messages: claimed, ...position, signal}`，旧版 `:911` **同句** | ✅ 一致 |
| 12 | `tools/result (exec, result)` + `exec.token/agent/parent/signal`、`result.isError` | `agent-instructions/preset.ts:411-424` | `dsh-tools/lib/index.js:3417` dispatch `[scopeTarget, "tools/result", exec, result]`（旧版 `:3417` 同句） | ✅ 一致 |
| 13 | `loader/volatile-update` | `src/index.ts:134` | `cordis-plugin-loader@1.0.5` `lib/index.js:420` `fiber.ctx.emit(self,"loader/volatile-update",paths)`；类型仍在 `lib/types/index.d.ts:29` | ✅ 一致（同版本包） |
| 14 | `settings/document-updated`（`args[0] === CORE_ROW_ID`） | `src/index.ts:141-143` | `dsh-settings/lib/index.js:435,461` 首参仍是 `entry.options.id` / `previous.ns`；dsh-settings **全文件两版相同** | ✅ 一致 |
| 15 | 客户端 `plugin-manager/changed` | `src/client/index.ts:233` | `dsh-plugin-manager/lib/index.js:2054` 仍 `emit("plugin-manager/changed",{reason})` | ✅ 一致 |
| 16 | 客户端 `slots` / `remote` / `locale` / `configForms` 四个服务键 | `src/client/index.ts:1012,223,1018,179` | 提供者分别在 `dsh-client-ui-renderer:1323`、`dsh-api-gateway:1595`、`dsh-client-locale:1526`、`dsh-client-ui-settings:1284`；其中 renderer / gateway / ui-settings 的 `client.js` **两版逐字节相同** | ✅ 一致 |
| 17 | 客户端 slot 名与 key 格式 | `src/client/index.ts:1035,1048,1053` | `rowConfigKey(bundle,rowId) = \`${bundle}#${rowId}\``（两版 `client.js:27-29` 逐字节相同）；`settings.section` / `plugins.bundle.config` / `plugins.row.config` 三个 slot 名 + `entryKey: pkg.name` 用法两版相同 | ✅ 一致 |
| 18 | 接管引擎的输入：shipped 预设行 | `src/core/components.ts:37,45`（`agent-instructions` / `skill-filesystem`） | `dsh-web-app/presets/{standard,minimal,ptc,cordis}.patch.yml` **四个文件两版 md5 完全相同**（`25bd75ac…` / `14f88acb…` / `90a1abe0…` / `366bdc53…`），行 id、模块名、`disabled` 全同 | ✅ 一致（这是接管正确性的地基） |
| 19 | 被替代的两个内建实现 | `src/components/**` | `dsh-agent-instructions/lib/index.js` 与 `dsh-skill-filesystem/lib/index.js` **两版逐字节相同** | ✅ 一致（移植基线未动） |
| 20 | 客户端半边的 external `react` 是否在平台种子里 | `tsdown.config.ts:6-7`（`CLIENT_EXTERNALS`）、产物 `lib/client.js` | 产物里唯一的裸 `require` 是 `react`；`dsh-client-modules/lib/client.js:548,700` 的 `makeRequire` 先查平台种子 `staticModules`；安装里 **47 个 shipped client 插件**都 `require("react")`，提供 `slots` 的 `dsh-client-ui-renderer/lib/client.js:12` 自己也 `require("react")` / `react-dom` / `react/jsx-runtime` → `react` 必然是种子词 | ✅ 一致（客户端半边不会因 externals 漂移而 require 失败） |

> 客户端 `dsh.client.inject` 的单独判定（`@deepseek-ai/dsh-client-ui-slots` 其实**不是** client graph row、因而那条 inject 是惰性的）在 B 部分报告里，见 `reports/T4-B-final-diff.md` 第 2 节。

### 2.3 唯一一处“运行时能观察到、但两版相同”的行为差异

`dsh-agent-loop` 在 0.2.0-rc.1 新增了工具声明投影（`developer/message` + `tool-addition`/`tool-removal`）与 `ToolCallRecovery`。用 grep 复核本包监听面：本包只消费 `session/event` 的 `step/start|step/end|turn/end` 与 `agent/pre-step` 的 `decision.messages`，**不解析 developer message 内容块**，新事件类型不会进入它的分支。→ 无影响。

---

## 3. 分级问题清单（A 部分）

### 阻断：0 条

### 应修：0 条

### 提示

**P1（既有，非本次升级引入）— `agent/pre-step` 决策重建会丢掉别的插件设在决策上的字段。**

```
src/components/agent-instructions/preset.ts:389-391
    const decisionCleaned: PreStepDecision = cleanMessages.length === decisionMessages.length
      ? decision
      : { kind: 'enter', messages: cleanMessages }        ← 只留了两个字段
```

`PreStepDecision` 的 `enter` 分支除 `messages` 外还有 `startsRequestSeries?: true`：

- 定义：`dsh-agent/lib/types/runtime-types.d.ts:92`（**0.1.7-rc.1 就有，两版相同**）
- 消费：`dsh-agent-loop/lib/index.js:1051` `const startsRequestSeries = firstAttempt && decision.startsRequestSeries === true`（旧版 `:1036` 同句）
- 唯一生产者：`dsh-goal-round-driver/lib/index.js:338` `startsRequestSeries: true`（该包 0.1.7-rc.1 `:338` 也有）

即：goal 轮次驱动与本包同挂 `agent/pre-step`，一旦本包走到“丢弃未标记消息”的重建分支（这正是它去重的目的），goal 的 series 边界标记会被静默丢掉。

- 触发条件窄：需要同时（a）装了 goal 能力、（b）决策里存在**未带 `provider: instruction-scan` 标记**的 workspace 消息（半接管 / 内建行未停用）。
- **两版行为完全相同，所以不是本次升级的回归**，故只列提示。若要顺手修：`{ ...decision, messages: cleanMessages }`（一行）。
- 复现：`grep -n "startsRequestSeries" ~/.local/lib/node_modules/@deepseek-ai/dsh/node_modules/@deepseek-ai/{dsh-agent-loop,dsh-goal-round-driver}/lib/index.js`

**P2（文档口径）— 坑 18 里「`@deepseek-ai/dsh-client-runtime` 在 0.2.0 已不存在（npm 404）」的说法不准确。**

实测：该包**存在**，共 11 个版本，最高 `0.1.1-rc.2`（2026-08-21 发布），npm dist-tags 为 `latest: 0.0.1-rc.1` / `next: 0.1.1-rc.2`：

```
npm view @deepseek-ai/dsh-client-runtime versions   # → 0.0.1-rc.1 … 0.1.1-rc.2（11 个）
npm view @deepseek-ai/dsh-client-runtime dist-tags  # → { latest: '0.0.1-rc.1', next: '0.1.1-rc.2' }
```

准确的表述应是：**它没有 dsh 0.2.0 线的版本，且不在 0.2.0-rc.1 的运行时依赖树里**（`ls .../@deepseek-ai/ | grep client-runtime` 无命中）——所以 `^0.1.1-rc.2` 这条 peer 必被闸门拒绝（已由上面的 HEAD 对照实测确认），删掉是对的。风险：后来者若按「npm 404」理解为「网络/镜像问题」而去重新加回这个 peer，闸门只校验**范围**、不校验**包是否存在于安装树**（`dsh-app-boot/lib/index.js:294,300`），加个覆盖 0.2.0-rc.1 的范围就能"骗过"闸门，但 profile 里解析不到这个包。

**P3（既有，非本次升级引入）— `resolveDshHome()` 的 env 兜底把 DSH_HOME 又拼了一层。**

```
src/components/skill-filesystem/provider.ts:262
    const home = process.env.DSH_HOME?.trim() || process.env.HOME
    return home ? join(home, '.dsh') : undefined
```

`DSH_HOME` 按 `dsh-home-paths` 的语义**本身就是 dsh home 目录**（`lib/index.js:15 const DSH_HOME_ENV = "DSH_HOME"`，`dshHomePath(...segments) => join(resolveDshHome(), ...segments)`），再 `join(home, '.dsh')` 会多一层。
实际不可达：第一分支 `ctx.get('dshHomePath')` 在 app-boot 下总是拿到函数（见 2.2 #7），env 兜底只在非 app-boot 嵌入时生效；`resolveDshHome` 在本包内也没有调用点（只有 `resolveUserHome` 被 `preset.ts:21` 使用）。故仅记录，不建议本次动。两版行为相同。

---

## 4. 「我尝试证伪但未能证伪」的记录

以下是我**主动构造的证伪尝试**，逐条失败（即：没能找到反例，因此上面的"无破坏性漂移"结论成立）：

1. **证伪「静态面无删除」**：把 21 个包的**全部 `.d.ts`** 拼起来做逐行 diff，专门找 `<`（旧有新无）行。找到的删除只有 `modeSelectionEnabled`、`generateConfigSchema(binName,…)`、`skippedProfileBundles` 三处 → 再对三者做仓库全量 grep（`src/ scripts/`），**0 命中**。反例证伪失败。
2. **证伪「符号存在性」**：写脚本按 `import { … } from '@deepseek-ai/*'` 解析 `src/` 的 19 个导入名，逐个在 0.2.0-rc.1 的 `lib/types/**/*.d.ts` 里查找 → 19/19 命中（唯一一条报"缺失"是我正则把 `import { Service, type Context }` 里的内联 `type` 当成符号名的脚本瑕疵，非真实缺失）。
3. **证伪「服务键有提供者」**：把 `ctx.get('X')` 的 12 个键全列出来，在安装树里找提供方（`super(ctx,"X")` / `ctx.provide("X"`）→ 12/12 找到（含 `dshHomePath` 这个非 Service 的 `provide`）。没有任何"键名漂移导致永远 undefined"的情况。
4. **证伪「事件还在发」**：对 6 个事件逐个 grep **发出点**（不是接收点）：`session/event`（dsh-session:1465）、`agent/pre-step`（dsh-agent-loop:911）、`tools/result`（dsh-tools:3417）、`loader/volatile-update`（cordis-plugin-loader:420）、`settings/document-updated`（dsh-settings:435,461）、`plugin-manager/changed`（dsh-plugin-manager:2054）→ 6/6 仍在发，且载荷首参逐一核对未变。
5. **证伪「接管地基被动过」**：直接对 4 个 shipped 预设 patch 与两侧 `dsh-base/cordis.patch.yml` 做 md5/逐行比对 → 预设**四个文件 md5 完全相同**（连注释都一样）；`dsh-base` 有改动但只是新增 `otel` 行与把 `llm-deepseek` 拆成 `llm-deepseek-api-key`+`llm-deepseek-account`，**不在任何预设组合内**（预设文件没变即证明）。
6. **证伪「差分对象搞错了」**（最关键的一条）：GUI 19387 由桌面 App 的 `app.asar/dsh` 提供，而我最初手上的类型来自 `~/.local` 那份 CLI 安装 —— 若两者不同，前面所有结论都作废。于是解 asar 枚举 290 个包版本，并对 17 个关键文件算 sha256：**版本号逐个相同、17/17 哈希相同**。证伪失败，结论可用。
7. **证伪「类型检查是假绿」**：`tsc --noEmit --traceResolution` → `exit=0`、`error TS` 0 条；解析结果确认 `@deepseek-ai/dsh-*` 全部落到 `~/.local/.../@deepseek-ai/dsh/node_modules/@deepseek-ai/<pkg>/lib/types/index.d.ts`（**不是**仓库 `node_modules`，仓库里只有 6 个 `@deepseek-ai` 包且版本也都是 0.2.0-rc.1）。坑 19 说的"静默回退"没有发生。
8. **证伪闸门**：不用心算，直接 import app-boot 导出的 `evaluatePluginCompatibility` 跑真函数；工作树 PASS，HEAD 旧 package.json REJECT（附完整拒绝理由）。并用 semver 7.8.5 跑 12 个版本 × `includePrerelease:true` 的矩阵（附录 B）。

**唯一"确实有问题"的发现**是第 3 节 P1/P2/P3 三条，且三条都不是本次 0.2.0-rc.1 升级引入的漂移（P1/P3 两版行为相同，P2 是文档措辞）。

---

## 5. 覆盖面声明

**已覆盖**：静态类型面（21 包全量 `.d.ts` + 19 个导入符号逐符号签名）／动态服务面（12 个 `ctx.get` 键、方法名、返回结构、运行时实现源码级比对）／事件面（6 个事件的**发出端**载荷与派发代码）／客户端面（4 个服务提供者、3 个 slot 名、key 拼接函数、`configForms.get().getSnapshot()/subscribe()` 用法）／接管输入面（4 个 shipped 预设 + 内建行 id + `preset-*` 声明行）／被替代实现面（`dsh-agent-instructions`、`dsh-skill-filesystem` 逐字节相同）／闸门面（真函数 + 真 semver）／类型解析面（traceResolution）／**清单面与解析路由面（第 6 节：构建产物裸导入全集 + 原生解析实测 + `readPeerNames`/`routeLinked` 机制）**。

**未覆盖（留给 T3/B）**：真实 profile 上的端到端安装→接管→RPC（T3）；`lib/` 产物与 `src/` 一致性、externals、越界改动（B，等最终 diff 冻结）；GUI 页面实际渲染（T3 截图/浏览器）。

**已知局限**：0.1.7-rc.1 的**运行安装**在本机已不存在，旧侧证据取自 npm tarball（`@0.1.7-rc.1`）。cordis / loader 的"当时实际解析版本"无法直接观测，我用的判据是 `dsh-app-boot@0.1.7-rc.1` 的 peer 范围（`~4.0.4` / `~1.0.5` / `~1.0.9` / `~1.0.4`）与本次安装实际版本（4.0.4 / 1.0.5 / 1.0.9 / 1.0.4）**互相满足**，因此两侧是同一份 cordis。

---

## 6. T5 交叉复核：裸导入与 linked 层路由（阻断缺陷，独立复核）

T3 在真实 scratch profile 上发现、Lead 定位为 T5 的阻断缺陷：preset 平面的 `dsh-plugins-plus-agent-instructions` 行**从未启动**，状态接口答 `"broken":"… never started"`；该 preset 里内置 `agent-instructions` 又已被我们 gate 成 `disabled: true`，于是**该预设完全没有 AGENTS.md 注入**。

我不采信结论，自己把整条链重建了一遍：

**(1) 构建产物的裸导入全集（我自己枚举，不引用别人的清单）**

```bash
cd <repo>
for f in lib/index.js lib/agent-instructions.js lib/agent-instructions-preset.js \
         lib/skill-filesystem.js lib/skill-filesystem-preset.js; do
  echo "--- $f"; grep -oE '^import [^;]*from "[^"]+"|^import "[^"]+"' "$f" | grep -oE '"[^"]+"' | sort -u
done
# → 非 node: 的裸导入全集 = @deepseek-ai/cordis、@deepseek-ai/dsh-llm、chokidar、yaml
#   其中 @deepseek-ai/dsh-llm 只出现在 lib/agent-instructions-preset.js
```

**(2) 这 4 个裸导入在本仓库里能不能原生解析**

```bash
node --input-type=module -e "
import { pathToFileURL } from 'node:url'
const parent = pathToFileURL(process.cwd()+'/lib/agent-instructions-preset.js').href
for (const s of ['@deepseek-ai/cordis','@deepseek-ai/dsh-llm','chokidar','yaml'])
  try { console.log('OK   ', s, import.meta.resolve(s, parent)) } catch (e) { console.log('FAIL ', s, e.code) }"
# → OK cordis / OK chokidar / OK yaml / FAIL @deepseek-ai/dsh-llm  ERR_MODULE_NOT_FOUND
```

**(3) 为什么"声明成 peer"能修好——DSH 侧的机制**

`dsh-app-boot/lib/index.js`：

```
1224  function readPeerNames(directory) {
1226    const peers = JSON.parse(readFileSync(join(directory, "package.json"), "utf8")).peerDependencies
1227    return new Set(peers !== null && typeof peers === "object" ? Object.keys(peers) : [])
1231  }
1471  routeLinked(request, name, parent, resolution, flavor, cjs) {
1472    const target = resolution.entries.get(name)
1473    if (target === void 0) return { route: { kind: "native" } }
1474    const ancestors = this.nodeModulePaths(dirname(parent))
...
1480      if (ancestorSet.has(searchPath) && readPeerNames(directory).has(name)) { … kind: "interception" … }
1499      const candidate = localPackageCandidate(searchPath, name, flavor)
```

即：被 `link:` 进来的插件，其裸导入只有在**本包 `package.json` 的 `peerDependencies` 里点名**时，loader 才按 interception 从 DSH 安装里提供；否则退回原生解析。对本仓库而言，`lib/` 向上的祖先 `node_modules` 链里既没有 `dsh-llm`（它只是 tsconfig `paths` 映射的类型来源），`readPeerNames(<repo>)` 也读不到它 —— 两条路都断，import 必然失败，行因此 `never started`。`chokidar`/`yaml` 是真 `dependencies`（`node_modules/.pnpm/chokidar@5.0.0` / `yaml@2.9.1`），原生可解析，所以只有 `dsh-llm` 是缺口。

**(4) 修法与当前状态**

Lead 已在 `package.json` 落地：

```json
"@deepseek-ai/dsh-llm": "^0.1.7-alpha.2 || ^0.2.0-rc.1"   // peerDependencies
"@deepseek-ai/dsh-llm": { "optional": true }               // peerDependenciesMeta
```

我复核后确认：`evaluatePluginCompatibility` 对新 manifest 仍返回 `undefined`（闸门未被这次新增打回）。**真实链路的最终证据仍以 T3 重跑后的 `/api/dsh-plugins-plus/status`（`broken` 消失、`pipeline:true`）与 patch 还原为准，那不属于我能独立制造的场景。**

**(5) 这条与 A 部分结论的关系**

它**不是** API 漂移：`dsh-llm` 的 `createUserMessage` / `Message` 两版逐字节相同（见 2.2 表）。它暴露的是 A 部分开头那句话的反面——"tsc 0 错误"甚至"符号签名未变"都不保证运行时可加载；**清单面（manifest）+ 解析路由面**必须单独验。这是本次审查里唯一一条够得上"阻断"的缺陷。

---

## 附录：复现命令

### A. 两份安装是同一构建（17/17 哈希相同）

```bash
APP="/Applications/DeepSeek Harness.app/Contents/Resources"
lsof -nP -iTCP:19387 -sTCP:LISTEN        # pid → ps 显示入口 = app.asar/dsh/.../dsh-desktop-host/lib/index.js
pnpm exec node reports/asar-read.mjs "$APP/app.asar" versions
# → 290 个包；除 dsh、dsh-desktop-host 外全部 x.y.z-rc.1（cordis 4.0.4 / loader 1.0.5 / include 1.0.9 / group 1.0.4 / schemastery 3.18.4）
R=~/.local/lib/node_modules/@deepseek-ai/dsh/node_modules/@deepseek-ai
for f in dsh-app-boot/lib/index.js dsh-config-editor/lib/index.js dsh-agent-preset-registry/lib/index.js \
         dsh-agent-loop/lib/index.js dsh-session/lib/index.js dsh-tools/lib/index.js dsh-llm/lib/index.js \
         dsh-hmr/lib/index.js dsh-settings/lib/index.js dsh-skill/lib/index.js dsh-fs/lib/index.js \
         dsh-agent/lib/index.js dsh-host-webserver/lib/index.js dsh-agent-instructions/lib/index.js \
         dsh-skill-filesystem/lib/index.js dsh-base/cordis.patch.yml dsh-web-app/presets/standard.patch.yml ; do
  a=$(node reports/asar-read.mjs "$APP/app.asar" hash "dsh/node_modules/@deepseek-ai/$f" | awk '{print $1}')
  l=$(shasum -a 256 "$R/$f" | awk '{print $1}')
  [ "$a" = "$l" ] && echo "SAME  $f" || echo "DIFF  $f"
done      # → 17 行 SAME
```

### B. 真闸门 + 真 semver

```bash
cd <repo>
node --input-type=module -e "
import { readFile } from 'node:fs/promises'
import { evaluatePluginCompatibility, pluginCompatibilityWarning }
  from '/Users/zhang3/.local/lib/node_modules/@deepseek-ai/dsh/node_modules/@deepseek-ai/dsh-app-boot/lib/index.js'
for (const f of ['/tmp/package.json.head', './package.json']) {
  const m = JSON.parse(await readFile(f, 'utf8'))
  const i = evaluatePluginCompatibility(m)
  console.log(f, i === undefined ? 'PASS' : pluginCompatibilityWarning(i).split('\n')[0])
}"
# → HEAD: REJECT（含 @deepseek-ai/dsh-client-runtime: ^0.1.1-rc.2）
# → 工作树: PASS

S=/Users/zhang3/.local/lib/node_modules/@deepseek-ai/dsh/node_modules/semver
node -e "const s=require('$S');for(const v of ['0.1.7-rc.1','0.1.7-rc.2','0.2.0-rc.1','0.2.0','0.2.99','0.3.0','0.1.6'])
  console.log(s.satisfies(v,'^0.1.7-alpha.2 || ^0.2.0-rc.1',{includePrerelease:true}), v)"
# → true true true true true false false
```

### C. 类型解析落点（证明不是假绿）

```bash
cd <repo>
node node_modules/typescript/bin/tsc --noEmit --traceResolution > /tmp/trace.txt 2>&1
grep -c "error TS" /tmp/trace.txt          # → 0
grep -oE "Module name '@deepseek-ai/dsh-[a-z-]+' was successfully resolved to '[^']+'" /tmp/trace.txt | sort -u
# → 全部指向 ~/.local/lib/node_modules/@deepseek-ai/dsh/node_modules/@deepseek-ai/<pkg>/lib/types/index.d.ts
```

### D. 旧包获取（不污染仓库）

```bash
mkdir -p /tmp/dsh-audit/old && cd /tmp/dsh-audit/old
for p in dsh-llm dsh-skill dsh-session dsh-fs dsh-agent dsh-tools \
         dsh-config-editor dsh-agent-preset dsh-agent-preset-registry dsh-settings \
         dsh-plugin-manager dsh-hmr dsh-host-webserver dsh-app-boot dsh-home-paths \
         dsh-web-app dsh-base dsh-agent-loop dsh-agent-instructions dsh-skill-filesystem \
         dsh-goal-round-driver dsh-tool-fs dsh-tool-str-replace-editor \
         dsh-client-ui-plugin-manager dsh-client-ui-settings dsh-client-ui-slots \
         dsh-client-locale dsh-cordis-client-runner dsh-api-gateway dsh-client-ui-renderer ; do
  npm pack "@deepseek-ai/$p@0.1.7-rc.1" --pack-destination . --cache /tmp/dsh-audit/npmcache
done
```

### E. 预设字节同一性

```bash
diff /tmp/dsh-audit/old/extracted2/deepseek-ai-dsh-web-app-0.1.7-rc.1/presets/standard.patch.yml \
     ~/.local/lib/node_modules/@deepseek-ai/dsh/node_modules/@deepseek-ai/dsh-web-app/presets/standard.patch.yml
md5 -q ...   # 两侧 25bd75ac98e8962fc4136f108056b278
```
