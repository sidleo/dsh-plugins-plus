# @sidleo3/dsh-plugins-plus

一个 DSH bundle，内含**多个可单独开关的组件**，每个组件替代一个内置插件并按 **agent 预设**生效。配置页在 **DSH 设置**里。

| 组件（Loader 行 id） | 替代的内置行 | 作用 |
|---|---|---|
| `dsh-plugins-plus` | — | 核心行：唯一持有配置 schema、接管引擎、只读状态接口 |
| `agent-instructions-plus` | `agent-instructions` | AGENTS.md 注入：四层扫描（cwd / 项目 / 逐级上级 / 全局）+ 可编辑文件名与预算 |
| `skill-filesystem-plus` | `skill-filesystem` | 技能发现：四层扫描 + 可编辑上级目录名（靠前优先） |

组件命名规则：**官方行 id + `-plus`**。以后新增组件 = 加一个 `exports`、加一行 `cordis.patch.yml`、加一处 schema、加一处 UI，无需新包、无需再装。

---

## 安装

```bash
# npm（推荐）
dsh plugin --profile <profile> add @sidleo3/dsh-plugins-plus

# 本地 checkout（开发）
dsh plugin --profile <profile> add link:/path/to/dsh-plugins-plus
```

装完**重启 DSH**。安装本身零改动：三个组件行里只有核心行默认开启，两个组件行默认 `disabled: true`。

## 启用组件（按需）

侧栏「插件」页 → `DSH Plugins Plus` 卡片 → 打开要用的组件行开关。组件的启用状态就是那一行的开关：

- 打开 `skill-filesystem-plus` → 引擎在选中的预设里禁用内置 `skill-filesystem` 行，并加入本插件的发现行；
- 关掉它 → 引擎撤销这些改动，内置实现恢复（撤到与 shipped 组合等价时，覆盖行会被 DSH 自己删掉）。

## 配置（设置 → DSH Plus）

一个页面，三处入口，同一套 UI：

| 入口 | 位置 |
|---|---|
| **设置 → DSH Plus** | 一级设置分区（推荐） |
| 侧栏「插件」→ 本 bundle 卡片 | `plugins.bundle.config` |
| 侧栏「插件」→ 组件行「配置」 | `plugins.row.config`（key 为 `<包名>#<行 id>`） |

页面内容：

- **全局配置**：接管哪些 agent 预设（勾选 / 全部 / 不接管）。所有组件默认继承它。
- **每个组件卡片**：生效范围（继承全局 / 单独指定）、组件参数（扫描层、上级目录、文件名、字节预算…）、当前每个预设的接管状态。

页面底部只有一个 **运行日志 ↗** 链接：接管引擎的运行记录（迁移结果、每次接管的原因与写入、失败与提示）在新标签页里以纯文本打开（`/api/dsh-plugins-plus/log`），不占配置页面。

写入走 DSH 官方管线（`ctx.configForms` → settings → config editor → profile 的 `cordis.patch.yml`）：

- 配置落在**当前 profile 的 patch**里（核心行的 `config`），本插件不再写自己的 JSON 文件；
- 每个字段都有继承语义：「恢复默认」= `unset`，回落 schema 默认值；
- 保存即时生效（核心行只在组件参数/接管清单变化时重算，不会重挂插件）。

> 会话创建时固定预设组合，所以接管改动影响**之后新建**的会话；已运行的会话不受影响。

## 与内置实现的差异

| 维度 | 内置 | 本插件 |
|---|---|---|
| 生效范围 | 所有预设 | 只在勾选的预设里（可全局=全部） |
| 向上扫描 | 只到项目根（`.git`） | `scanProject` 或 `scanParents`（一路到 `/`）二选一 |
| cwd / 全局层 | 固定 | 独立开关 |
| 技能上级目录 | 固定 | 可增删改 + 排序 |
| 配置位置 | 各自 JSON 文件 | DSH 设置（profile patch） |

## 从旧的两个插件迁移

旧包：`@sidleo3/agent-instructions-plus`、`@sidleo3/skill-filesystem-plus`。

```bash
dsh plugin --profile <profile> add @sidleo3/dsh-plugins-plus
dsh plugin --profile <profile> remove @sidleo3/agent-instructions-plus
dsh plugin --profile <profile> remove @sidleo3/skill-filesystem-plus
# 重启 DSH
```

重启后引擎自动做两件事（各一次，记录在配置的 `legacyImport` 时间戳里）：

1. 把 `~/.dsh/dsh-instruction-scan.json`、`~/.dsh/dsh-skill-filesystem-plus.json` 里**尚未在 profile 中声明**的字段导入到 `components.*`；
2. 把旧 wizard 已接管的预设，沿用为该组件的预设选择（`useGlobalPresets: false` + 勾选清单）。
3. 旧的 pipeline 行（`*-plus-pipeline` 与旧模块名）会被就地改写成新模块名，不会重复。

> **旧 JSON 文件不会被改名或删除**——它们位于共享的 `~/.dsh`，其他仍在跑旧插件的 profile 还要用。确认无用后自行删除即可。

## 兼容性

| DSH 版本 | 状态 |
|---|---|
| `0.1.7-rc.2` | ✅ 本版本开发与实测的基线 |
| `0.1.7-alpha.2` 及以后 | ✅ 设计目标（使用 `settings.section`、`plugins.bundle.config`、`plugins.row.config`、`ctx.configForms`、`ctx.configEditor`、`agentPresets.compositionInventory`） |

用到的 DSH 能力与版本敏感点集中在 `src/core/`（`composition.ts`、`takeover.ts`、`hmr.ts`、`rpc.ts`），DSH 再次改动时优先看这几个文件。

## 开发

```bash
pnpm install --ignore-scripts
pnpm resolve-types     # 从正在运行的 DSH 安装解析 @deepseek-ai/* 类型（.dsh-types/，gitignore）
pnpm typecheck         # 期望 0 错误
pnpm build             # tsdown → lib/{index,agent-instructions,skill-filesystem,*-preset,client}.js
pnpm smoke             # 28 项检查：schema / 继承 / 接管规划 / 迁移 / client 契约
```

改完代码要立即看效果：

```bash
dsh plugin --profile <p> remove @sidleo3/dsh-plugins-plus
dsh plugin --profile <p> add link:/path/to/dsh-plugins-plus
pnpm build && # 重启 DSH
```

发布前自检：

```bash
pnpm typecheck && pnpm build && pnpm smoke
grep -c 'plugins.bundle.config' lib/client.js            # ≥1：注册了 bundle 配置页
head -c 80 lib/client.js | grep -c '__ModuleLoader__'    # 1：client 是 CJS factory 包装
grep -rn 'from "\./.*\.d\.ts"' lib/*.js                  # 0 行：不得把类型当运行时模块
```

## 许可

MIT
