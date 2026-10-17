# dsh-plugins-plus 项目规范

> DSH（DeepSeek Harness）单包多组件增强插件：一个 bundle 里若干**可单独开关的组件**，每个组件按 agent 预设替代一个内置插件；配置在 **DSH 设置**里。
>
> 本文件是本仓库的唯一指令来源，CLAUDE.md / CODEBUDDY.md 是指向它的软链接。本仓库位于用户项目根 `/Users/zhang3/yh_zhang3/` 的 AGENTS.md 作用域内；冲突时**本仓库 AGENTS.md 优先**。

## 项目是什么

- **包名**：`@sidleo3/dsh-plugins-plus`（v0.1.8）
- **仓库**：GitHub `sidleo/dsh-plugins-plus`（分支 `main`）
- **组件**：`agent-instructions-plus`（替代 `agent-instructions`）、`skill-filesystem-plus`（替代 `skill-filesystem`）；命名规则 = 官方行 id + `-plus`
- **核心行**：`dsh-plugins-plus` — 唯一常开行，持有配置 schema、接管引擎、只读状态接口
- **取代**：`@sidleo3/agent-instructions-plus@0.3.4` 与 `@sidleo3/skill-filesystem-plus@0.2.5`（两个旧包保留但停止更新）

## 目录结构

| 路径 | 职责 |
|---|---|
| `src/index.ts` | 核心行：`Config` schema、服务、引擎装配（挂载 / volatile 更新 / settings 写入 → 去抖重算）、迁移、只读 RPC |
| `src/core/config.ts` | 唯一配置 schema（含 `.volatile()` 布局）+ 归一化 + 全局/组件继承解析 |
| `src/core/components.ts` | 组件表：行 id、内置行 id、pipeline 行 id/模块名、旧版 id/模块名 |
| `src/core/composition.ts` | 通过 `configEditor.configuration()` + `agentPresets.compositionInventory()` 读预设组合（不解析 YAML） |
| `src/core/takeover.ts` | **纯函数规划器** `planPreset`/`mergeRows` + `reconcile`（写盘走 `configEditor.edit`） |
| `src/core/registry.ts` | `dshPluginsPlus` 服务：配置快照、组件注册表、引擎钩子 |
| `src/core/legacy.ts` | 旧插件 JSON 配置一次性导入 + 旧接管选择沿用（**只读，不改名不删除**） |
| `src/core/hmr.ts` | 在 HMR 事务之外执行写盘（`hmr.executing.exit`，特性探测） |
| `src/core/rpc.ts` | 只读 HTTP：`/api/dsh-plugins-plus/{status,log,reconcile}`（`log` 返回 text/plain） |
| `src/components/<组件>/index.ts` | 组件行：挂载即向核心注册自己（= 组件启用） |
| `src/components/<组件>/preset.ts` | 会话平面：真正替代内置实现（技能 provider / 指令注入管线） |
| `src/components/agent-instructions/{discovery,files,state,render,digest,config}.ts` | 从旧包移植的注入管线实现 |
| `src/components/skill-filesystem/{provider,watcher,config}.ts` | 从旧包移植的发现实现 |
| `src/client/index.ts` | 浏览器半：`settings.section` + `plugins.bundle.config` + `plugins.row.config`，读写全走 `ctx.configForms`；页面只有配置，运行日志走页脚链接 |
| `scripts/smoke.mjs` | 34 项自检：schema / 继承 / 规划器（幂等、还原、外来编辑、旧行改写）/ 迁移 / client 契约 / **产物裸导入 ⊆ manifest**（坑 20 的回归防线） |
| `locale/` + `locale/<组件>/` | 插件页卡片与组件行的本地化标题/描述（`{"meta":{title,description}}`） |

## 常用命令

```bash
pnpm install --ignore-scripts
pnpm resolve-types   # 从正在运行的 DSH 安装解析类型 → .dsh-types/tsconfig.paths.json
pnpm typecheck       # 必须 0 错误
pnpm build           # tsdown：5 个 ESM + 1 个 CJS client
pnpm smoke           # 34 项检查，改规划器/迁移/client/依赖声明后必跑（读 lib/，先 build）
```

**DSH 升级后必做**（顺序不能反，否则会得到假绿）：

```bash
dsh --version                        # 先确认运行版本
# 1) 改 package.json 的 peer/dev 范围（见坑 18）
pnpm install --ignore-scripts
pnpm resolve-types                   # 输出必须显示 dsh runtime: <新版本>，且无 version skew 警告
pnpm typecheck && pnpm build && pnpm smoke
dsh --profile <scratch> add link:$PWD   # 安装闸门必须在真实 DSH 上过
```

## 架构要点

- **一个包三个行**：`cordis.patch.yml` 里核心行常开、两个组件行 `disabled: true`。加组件 = 组件表加一项 + `exports` 加一个 + patch 加一行 + schema/UI 各加一段。
- **配置只有一处**：核心行的 `Config`。组件行不持配置，所以组件可以在启用前先配置；被禁用的行其 namespace 不再被服务，配置也就写不了。
- **配置 → 接管是声明式的**：配置里写「接管哪些预设」→ 引擎把 shipped 组合 + 本次编辑算成新组合 → `configEditor.edit()` 落盘。撤到与 shipped 等价时，DSH 自己删掉覆盖行，无需我们做字节级还原。
- **行按 shipped 重算**：`mergeRows` 从 shipped 行出发，保留 override 的外来改动（别的插件改过的行、加过的行），所以 DSH 升级新增的预设行会自动生效（旧实现会把整表固化）。
- **组件启用状态 = 那一行的挂载状态**。引擎对「本进程从未挂载过」的组件不动它的行（避免启动序列中把接管误删）。

## 改代码前必读的坑

1. **externals 必须与 loader 模块表一致**（`tsdown.config.ts:RUNTIME_EXTERNALS`）。漏掉 `@deepseek-ai/dsh-llm` 这类运行时包会把它的副本 inline 进产物（身份重复、体积暴涨）；反过来把 `@deepseek-ai/schemastery` 当 external 会 `ERR_MODULE_NOT_FOUND`——它必须 inline。
2. **`resolve-dsh-types.mjs` 不能映射「值导入」的包**。曾经把 `@deepseek-ai/schemastery` 也映射到运行安装的 `lib/types/index.d.ts`，打包器于是把 `import z from '@deepseek-ai/schemastery'` 解析成声明文件，产物里出现 `import ... from "./chunk.d.ts"`（运行时必挂）。只映射纯类型导入或 external 的包。
3. **schemastery volatile 布局**：volatile 字段必须落在固定对象路径上，且**不能嵌套在另一个 volatile 字段内部**（`volatile fields require a fixed object path without an enclosing volatile field`）。本包只标三个节点：`presetsMode`、`presets`、整个 `components` 子树。
4. **`configEditor.edit` 的语义**：profile patch 对某行是**整份 `config` 替换**（不是深合并），所以每次都要写完整 config（`{...base, plugins}`）；`next` 与 inherited 深度相等时会**删掉覆盖行**；注释与 `!!js`（`{__jsExpr}`）由它往返保留；home patch/CLI overlay 更高层时会拒绝写入。
5. **HMR 事务不可嵌套**：`hmr.runExclusive` 用 `AsyncLocalStorage` 标记事务，「从 settings 写入回调 / plugin-manager 安装回调里 setTimeout 出来」的代码会**永久继承**该标记，于是 `configEditor.edit` 永远报 `HMR transactions cannot be nested`——首次尝试和后续重试都会失败。解法见 `src/core/hmr.ts`（`hmr.executing.exit`，特性探测 + 回退）。**必须包住整个 pass（迁移 + 接管），而不是只包 `reconcile`**：0.1.0 只包了后者，结果「运行中安装」时旧配置永远导不进来（0.1.1 修复；桌面 profile 就是这样复现的）。
6. **`settings.configure({auto:false}, fiber)` 的第二个参数必须是「行自己的 fiber」**（`ctx.fiber`）。传 `ctx.inject` 子 fiber 会注册到没人读的 key 上，现象是 `settings/describe` 里 `autoGenerate` 仍是 `true`。
7. **组件行开关只能用 loader entry id**：`pluginManager.setPluginEnabled('include:<row id>', enabled)`；传 patch id 会返回 `unknown-plugin`。我们自己的 UI 若要内嵌开关，注意这一点。
8. **不要动共享 DSH home 里的旧配置文件**。`~/.dsh/dsh-*.json` 属于整个 DSH，其他 profile 可能仍在用；导入只在配置里记 `legacyImport` 时间戳，文件保持原样。
9. **`mergeRows` 必须把自己的行也带出来**（早期版本把自有行当「引擎会重加」而丢弃，结果所有停用/未挂载路径都静默少行，`action` 判成 `none`）。自有行的去留只由激活/停用两段决定。
10. **停用时要精确还原 `disabled`**：从 shipped 行取该键（shipped 没有就删键，而不是写 `false`）；若「内置行被 gate 住但没有我们的行」（手工编辑/半途状态），也要还原，否则该预设会同时失去两个实现。
11. **手改 `cordis.patch.yml` 不一定触发重载**（实测 0.1.7-rc.2 的 HMR 没反应）：验证接管逻辑请走设置页（settings remote / configForms）或重启，别手改文件后等热更新。
12. **验证必须看真实链路**：`settings/describe` 能确认 namespace 被服务（`applies: live`、`autoGenerate: false`），`settings/mutate` 能确认写入即时生效；只用单元测试或只看 patch 文件都会漏掉接线问题（本项目就是靠这条抓出「通知没接引擎」和「HMR 嵌套」两个 bug）。
13. **实心按钮的 hover 不能复用 `.dppBtn` 的 hover 颜色**：`dppBtnPrimary` 的背景就是 `label-primary`，而通用 hover 规则把文字也刷成 `label-primary`——同特异性下后写的规则才生效，所以实心按钮自己的 `:hover` 规则必须排在通用规则之后（否则悬停时整个按钮变成一块纯色，0.1.1 的现象）。`scripts/smoke.mjs` 有对应检查，别把顺序调回去。
14. **启用状态靠 Host 事件刷新，且事件早于挂载**：客户端必须注入 `remote` 并 `ctx.remote.$on('plugin-manager/changed', …)` 重读 `/status`（0.1.1 只在 mount 时读一次，开关动了标签不跟着走）。事件发出时组件行**还没**完成 mount，紧跟的那次读取可能仍答 `mounted: false`（实测 activator 行在管理调用返回后约 80ms 才注册），所以 0.1.2 在 500ms / 1600ms 各补读一次——只读一次会偶发停在旧状态。
15. **Desktop shell 拒绝一切 `window.open`**：`app.asar/lib/main.js` 的 `setWindowOpenHandler` 只把 **https** 交给系统浏览器，其余一律 `{action:'deny'}`——所以 `target="_blank"` 指向 `http://127.0.0.1:…/api/…` 的链接点下去毫无反应（0.1.4 的现象）。日志这类内容一律**在页面内用浮层渲染**，不要开新标签。
16. **host 半边只在启动时加载**：浏览器半边按请求从磁盘读（刷新即新），host 半边是启动时 import 的（改路由/引擎必须重启 DSH）。所以新增 host 路由的功能要能容忍旧 host：0.1.5 的日志浮层在 `/log` 404 时回落到 `/status` 里的最近一次接管与迁移结果，并提示重启。
17. **卡片展开/收起必须用同一个图标旋转**：`⌃`(U+2303) 与 `⌄`(U+2304) 是两个不同字形，字重与基线都不同，展开/收起看起来不对称（0.1.2 的现象）。改成单个 SVG chevron + `.dppChevronOpen{transform:rotate(180deg)}`，两态才是严格镜像；`scripts/smoke.mjs` 有对应检查。
18. **DSH 有硬性 peer 兼容闸门，peer 范围必须覆盖运行版本**。`dsh-app-boot` 的 `evaluatePluginCompatibility`（`~/.local/lib/node_modules/@deepseek-ai/dsh/node_modules/@deepseek-ai/dsh-app-boot/lib/index.js:251-315`）遍历 `peerDependencies` 里**名字为 `@deepseek-ai/dsh` 或以 `@deepseek-ai/dsh-` 开头**的项，用 `semver.satisfies(runtimeVersion, range, {includePrerelease:true})` 校验。两种失败面，都要防：**(1) 安装期** —— `dsh plugin add` 直接拒绝（"installation rejected … nothing was installed"）；**(2) 加载期** —— 对**已经装好**的插件，DSH 在 profile 组装时把**整个 bundle 层**跳过：stderr 打 `dsh: skipping profile bundle "<pkg>": Error: Plugin <pkg>@<ver> is incompatible with dsh <runtime> …`。这一步发生在行级 preflight 之前，所以**不是**"某些行被 disable"，而是注入引擎、设置分区、只读路由、组件行**一起消失**（`/api/dsh-plugins-plus/status` 变 404，`settings/describe` 里没有该 namespace）。**升级 DSH 后如果整套功能凭空不见，先查这个**。复现脚本：`node scripts/e2e/run-deny-check.mjs`（9 项断言，含"豁免生效时不会 deny，必须先撤销豁免再启动"这个坑）。
    两个易错点：**(a)** `^0.2.0` **不匹配** `0.2.0-rc.1`（rc < 0.2.0），要写 `^0.2.0-rc.1`；**(b)** `@deepseek-ai/cordis`、`@deepseek-ai/schemastery` 不以 `dsh-` 开头，不参与判定，别指望它们挡住版本错配。0.1.5 → 0.2.0-rc.1 的迭代就是栽在这里（peer 还写着 `^0.1.7-alpha.2`）。另外 `@deepseek-ai/dsh-client-runtime` **没有 0.2.0 线的版本**（npm 上最新只到 0.1.1-rc.2，且不在 0.2.0-rc.1 的运行时依赖树里），别再往 peer/dev/`dsh.client.inject` 里写；注意闸门只校验**范围**、不校验包是否存在，所以写回一个不存在的包不会报错，只会让行静默失效。豁免（`dsh plugin allow-version` / `compatibility.json`）能救急，但等于放弃保护，正式发布必须靠改范围解决。
19. **`resolve-dsh-types.mjs` 的解析顺序决定 typecheck 是不是假绿**：旧顺序把本包 `package.json` 排在 DSH 安装**之前**，于是 devDependency 钉在 `^0.1.7` 时 `tsc` 一直拿 0.1.7 的类型对着 0.2.0 运行时校验，报 0 错误——升级完全没被发现。现在顺序是 **profile → DSH 安装 → 本包（兜底）**，并打印 `dsh runtime: <版本>` 与 `version skew` 警告。**`pnpm typecheck` 前务必确认输出里的 runtime 版本等于 `dsh --version`**。注意 TS 的 `paths` 映射失败会**静默回退**到 node_modules，所以「映射写错」不会报错，要查就得用 `tsc --traceResolution` 看它实际解析到了哪个文件。
20. **构建产物里 external 的每个裸导入，都必须在 `peerDependencies` 里点名，否则 `link:` 安装的插件会静默失效**。机制在 `dsh-app-boot`：`routeLinked`（0.2.0-rc.1 约 1469-1481 行，**0.1.7-rc.1 起就有且逐字节相同**）对 linked 插件逐级看祖先 `node_modules`，只有 `readPeerNames(directory).has(name)`（1224-1231，**读的就是 `peerDependencies`**）成立才给 `kind:'interception'` 交给 DSH 安装；否则退 native 解析——而从插件的 `lib/` 往上根本找不到 `@deepseek-ai/dsh-*`。**注意作用范围**：走 **profile 层**（registry 安装，`node_modules` 里是真目录）的插件不受影响——那条路径下 `routeLocalPackage` 只要本层没有本地候选就直接用安装提供；只有 `link:`（symlink）安装才会踩到。后果是**静默**的：preset 平面那行永远不启动，`compositionInventory()` 把它报成 `broken: "…: never started"`，引擎于是跳过该预设（→ 坑 22） → **接管永远释放不掉**；更糟的是内置行已被 gate 成 `disabled: true`，于是那个预设**一个指令注入源都没有**。自检命令：
    ```bash
    # 构建产物里所有裸导入（不含 node: 与相对路径）
    grep -ho 'from "[^".][^"]*"' lib/*.js | sed 's/from "//;s/"//' | grep -v '^node:' | sort -u
    # 逐个确认：是 peerDependencies 的 key，或是 dependencies（能原生解析）
    ```
    **判据落在产物上，不在 `RUNTIME_EXTERNALS` 表上**：该表 12 项里只有 3 项（`dsh-llm`/`chokidar`/`yaml`）真出现在 `lib/*.js`，其余是 `import type`、构建时被擦除（`cordis` 由 `CLIENT_EXTERNALS` 展开进来）。按表核会得到一堆假阳性，只看表又会漏掉缺声明——「表里有、manifest 里没有」正是坑 20 的形态。这条已固化进 `pnpm smoke`（`manifest coverage of built imports`），改完依赖声明跑一次即可。**另一个方向的红线：别在 profile 里单独装 `@deepseek-ai/dsh-llm`**——profile 层的 `localPackageCandidate` 优先于 interception，装了就换成那份副本，`createUserMessage`/`Message` 的运行时身份与 DSH 内部不再是同一份（即坑 1 的复制身份问题）。profile 模板默认 `autoInstallPeers: false`，正常路径不会自动触发。
21. **`presets[].broken` 是"替代实现到底有没有真的起来"的唯一信号**。`@deepseek-ai/dsh-agent-preset-registry` 的 `compositionInventory()` 会挂载预设子树并审计每一行；`fiber === undefined` 就报 `never started`（该严重情况**不**区分"导入失败"与"依赖未满足"，因为只有拿到 fiber 的行才会继续等 `inject`）。它同时是引擎的门：`reconcile` 见到 `broken !== undefined` 就 `continue`（坑 22 说明为什么不能无条件跳过）。所以**改完 preset 平面必须查它**：`GET /api/dsh-plugins-plus/status` 的 `presets[].broken` 必须是 undefined。单元测试、`settings/describe`、甚至"接管写盘成功"全都不会发现这一类失败——0.2.0-rc.1 的迭代就是靠它才抓到坑 20。
22. **引擎不能无条件跳过 broken 预设，否则自己的旧行永远修不掉**。0.1.7 及更早的 `reconcile` 是 `if (broken !== undefined || rows.length === 0) continue`：只要预设 broken 就整条略过。而「旧版遗留的 pipeline 行指向已下架的旧包」恰恰**就是**某些自有预设 broken 的原因——`@sidleo3/skill-filesystem-plus/preset`、`@sidleo3/agent-instructions-plus/preset` 在旧包被移除后 import 必失败，`compositionInventory()` 报 `never started`。于是形成死锁：预设 broken → 引擎跳过 → 旧行没人改 → 预设永远 broken。现象是用户在 DSH Plus 里**勾不上自己的预设**（列表显示"预设不可用：…never started"），而 DSH 自带的 preset 一切正常。0.1.8 起改为：`rows.length === 0` 仍然跳过；`broken` 只在**预设里没有任何本插件拥有的行**（`ownsRow` 命中 `pipelineRowId`/`legacyPipelineRowIds`/`legacyPipelineModules`）时才跳过。判据是"这条 broken 是不是我造成的"，不是"这条预设坏没坏"。`pnpm smoke` 有两条回归用例（修复与本插件无关的 broken 预设保持不动）。注意前提：组件必须**已挂载**（`manageable`）引擎才会动它的行，所以用户侧的修复步骤是「启用组件 → 勾选预设」，只勾选不启用不会生效。

## 本地验证（一次性 scratch profile，不碰真实 profile）

```bash
dsh --profile smoke --from-default-profile web --dump-config
dsh plugin --profile smoke add link:$PWD
dsh --profile smoke --port 5399 --no-open     # 后台起，日志里取 token
# 取 cookie 后即可调真实 remote：
#   POST /api/settings/describe      {"args":{}}
#   POST /api/settings/mutate        {"args":{"ns":"dsh-plugins-plus","ops":[…],"expectedRevision":N}}
#   POST /api/pluginManager/setPluginEnabled {"args":{"id":"include:skill-filesystem-plus","enabled":false}}
#   GET  /api/dsh-plugins-plus/status|log        POST /api/dsh-plugins-plus/reconcile
```

请求体信封：`{"type":"client-request","rpcId":"…","method":"<ns>/<method>","payload":{"args":{…}}}`；先用 `?token=` 打开首页拿 cookie，否则 401。

## 发布

```bash
npm version minor --no-git-tag-version
npm publish --ignore-scripts      # prepack 会跑 pnpm build
```

发布后照 `README.md` 的自检清单核一遍产物，再按「一次 scratch profile 验证」跑通安装与接管。
