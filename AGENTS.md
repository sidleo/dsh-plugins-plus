# dsh-plugins-plus 项目规范

> DSH（DeepSeek Harness）单包多组件增强插件：一个 bundle 里若干**可单独开关的组件**，每个组件按 agent 预设替代一个内置插件；配置在 **DSH 设置**里。
>
> 本文件是本仓库的唯一指令来源，CLAUDE.md / CODEBUDDY.md 是指向它的软链接。本仓库位于用户项目根 `/Users/zhang3/yh_zhang3/` 的 AGENTS.md 作用域内；冲突时**本仓库 AGENTS.md 优先**。

## 项目是什么

- **包名**：`@sidleo3/dsh-plugins-plus`（v0.1.3）
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
| `src/core/rpc.ts` | 只读 HTTP：`/api/dsh-plugins-plus/{status,roots,reconcile}` |
| `src/components/<组件>/index.ts` | 组件行：挂载即向核心注册自己（= 组件启用） |
| `src/components/<组件>/preset.ts` | 会话平面：真正替代内置实现（技能 provider / 指令注入管线） |
| `src/components/agent-instructions/{discovery,files,state,render,digest,config}.ts` | 从旧包移植的注入管线实现 |
| `src/components/skill-filesystem/{provider,watcher,config}.ts` | 从旧包移植的发现实现 |
| `src/client/index.ts` | 浏览器半：`settings.section` + `plugins.bundle.config` + `plugins.row.config`，读写全走 `ctx.configForms` |
| `scripts/smoke.mjs` | 30 项自检：schema / 继承 / 规划器（幂等、还原、外来编辑、旧行改写）/ 迁移 / client 契约 |
| `locale/` + `locale/<组件>/` | 插件页卡片与组件行的本地化标题/描述（`{"meta":{title,description}}`） |

## 常用命令

```bash
pnpm install --ignore-scripts
pnpm resolve-types   # 从正在运行的 DSH 安装解析类型 → .dsh-types/tsconfig.paths.json
pnpm typecheck       # 必须 0 错误
pnpm build           # tsdown：5 个 ESM + 1 个 CJS client
pnpm smoke           # 30 项检查，改规划器/迁移/client 后必跑
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
15. **卡片展开/收起必须用同一个图标旋转**：`⌃`(U+2303) 与 `⌄`(U+2304) 是两个不同字形，字重与基线都不同，展开/收起看起来不对称（0.1.2 的现象）。改成单个 SVG chevron + `.dppChevronOpen{transform:rotate(180deg)}`，两态才是严格镜像；`scripts/smoke.mjs` 有对应检查。

## 本地验证（一次性 scratch profile，不碰真实 profile）

```bash
dsh --profile smoke --from-default-profile web --dump-config
dsh plugin --profile smoke add link:$PWD
dsh --profile smoke --port 5399 --no-open     # 后台起，日志里取 token
# 取 cookie 后即可调真实 remote：
#   POST /api/settings/describe      {"args":{}}
#   POST /api/settings/mutate        {"args":{"ns":"dsh-plugins-plus","ops":[…],"expectedRevision":N}}
#   POST /api/pluginManager/setPluginEnabled {"args":{"id":"include:skill-filesystem-plus","enabled":false}}
#   GET  /api/dsh-plugins-plus/status|roots      POST /api/dsh-plugins-plus/reconcile
```

请求体信封：`{"type":"client-request","rpcId":"…","method":"<ns>/<method>","payload":{"args":{…}}}`；先用 `?token=` 打开首页拿 cookie，否则 401。

## 发布

```bash
npm version minor --no-git-tag-version
npm publish --ignore-scripts      # prepack 会跑 pnpm build
```

发布后照 `README.md` 的自检清单核一遍产物，再按「一次 scratch profile 验证」跑通安装与接管。
