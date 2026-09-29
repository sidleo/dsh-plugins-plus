# T4-B｜最终 diff 对抗式审查（0.1.5 → 0.2.0-rc.1 兼容性迭代）

- 审查人：reviewer（T4），独立第三方；不采信 T2/T3 结论，全部自己重跑
- 审查对象：`642bb8e`（0.1.5）→ 冻结时的工作树
- **冻结范围（lead 确认）**：`package.json`、`AGENTS.md`、`README.md`、`README.zh-CN.md`、`pnpm-workspace.yaml`、`pnpm-lock.yaml`、`scripts/resolve-dsh-types.mjs` 已定稿；`src/**`、`tsdown.config.ts`、`cordis.patch.yml`、`scripts/smoke.mjs`、`locale/**` **零改动**。`scripts/e2e/**`（tester）与 `reports/**`（本审查）是交付物目录，不算产品 diff。
- **唯一保留可变项**：`package.json` 的 `version` 字段（发布版本号待用户拍板）。本报告的全部结论与 `version` 无关——peer 范围、产物、闸门、契约均不受版本号影响。

## 结论：**兼容**（可发布）。阻断 0 / 应修 0 / 提示 7（产品代码零问题；7 条全部是文档、测试盲区、惰性配置一类）。

---

## 1. peer 范围真 semver 矩阵（含新增的 `@deepseek-ai/dsh-llm`）

用 **DSH 安装自带的同一份 semver（7.8.5）**，`includePrerelease: true`，逐 peer 跑：

范围统一为 `^0.1.7-alpha.2 || ^0.2.0-rc.1`。

| 运行版本 | `^0.1.7-alpha.2 \|\| ^0.2.0-rc.1` |
|---|---|
| `0.1.6` | **UNSAT** ✅（正确地排除） |
| `0.1.7-rc.1` | SAT |
| `0.1.7-rc.2` | SAT |
| `0.2.0-rc.1` | SAT |
| `0.2.0`（将来稳定版） | SAT |
| `0.3.0` | **UNSAT** ✅（正确地排除） |

5 个 `@deepseek-ai/dsh-*` peer 逐个复跑，结论完全一致：

```
@deepseek-ai/dsh-agent-preset            ^0.1.7-alpha.2 || ^0.2.0-rc.1   → 0.1.6 F | rc1 T | rc2 T | 0.2.0-rc.1 T | 0.2.0 T | 0.3.0 F
@deepseek-ai/dsh-agent-preset-registry   ^0.1.7-alpha.2 || ^0.2.0-rc.1   → 同上
@deepseek-ai/dsh-client-ui-slots         ^0.1.7-alpha.2 || ^0.2.0-rc.1   → 同上
@deepseek-ai/dsh-llm（本次新增）          ^0.1.7-alpha.2 || ^0.2.0-rc.1   → 同上
@deepseek-ai/dsh-skill                   ^0.1.7-alpha.2 || ^0.2.0-rc.1   → 同上
```

真闸门（不用心算，import app-boot 导出的真函数）：

```
runtime: 0.2.0-rc.1 | gate: PASS          # 工作树
runtime: 0.2.0-rc.1 | gate: REJECT        # git show 642bb8e:package.json（对照）
```

---

## 2. `dsh.client.inject` 现状判定：**保留（正确且无害），但它不是顺序保证**

**事实核对（tester 的 F5 方向正确，我补上机制与结论）：**

| 项 | 实测 |
|---|---|
| `@deepseek-ai/dsh-client-ui-slots@0.2.0-rc.1` 的 `dsh` 字段 | **`undefined`**（没有 `dsh.client`） |
| 它的 `exports` | 只有 `.` / `./src/*` / `./package.json`，**没有 `./client`** |
| 它的 `lib/` | 只有 `index.js` + `types/` → **纯类型包**，不产出浏览器 bundle |
| 因此它是 client graph row 吗 | **不是**。client graph 只收 `dsh.client.platform === 'web'` 且导出 `./client` 的包（`dsh-client-modules/lib/index.js:709-717`：`decl === undefined \|\| decl.platform !== "web"` → `return null`） |
| 未知 inject id 的后果 | **静默跳过**：`dsh-client-modules/lib/client.js:655-658` `for (const packageName of row.inject) { const dependency = this.graphRows.get(packageName); if (dependency !== void 0) await this.arriveDependency(...) }` |
| 谁真正提供 `slots` 服务 | `@deepseek-ai/dsh-client-ui-renderer` 的 client bundle（`:1323 super(ctx, "slots")`），而它的 manifest 是 `{"client":{"platform":"web","immediately":true}}` → **bootstrap 期就 materialize，先于按行加载的插件** |

**结论：保留。**
- **保留的理由**：零成本、无害；它把"本包客户端半边依赖 slots 契约"这件事留在了 manifest 里（对读代码的人是信息）。
- **必须纠正的预期**：**它不提供任何加载顺序保证**（id 不在图里，等于空操作）。真正的保证来自 renderer 的 `immediately: true`。
- **不建议改成 renderer 的包名**：`immediately` 已经严格先行，再加一条依赖只会把我们的加载绑死在别人包的改名上。
- **对 F5 断言的精度的提醒（写给 tester/lead）**：`F5 = every id in dsh.client.inject exists in this DSH runtime` 只查"包是否存在"。`dsh-client-ui-slots` 确实存在（存在的是类型包），所以这条断言**恒真**，抓不到"注入的 id 不是 graph row"。若想让它有鉴别力，应断言"该 id 是 graph row，或是已知的纯类型包白名单"。
- **可选加固（未来迭代，本次不改 src）**：客户端半边现在是一次性 `ctx.get('slots')`，取不到就 `console.warn` + `return`（`src/client/index.ts:1011-1016`）——是一条静默失败路径。若要与 DSH 解耦，可改 `ctx.inject(['slots'], …)`。当前由 renderer 的 `immediately` 兜住，不构成风险。

删除 `@deepseek-ai/dsh-client-runtime` 的判定：**正确**（该包不在 0.2.0-rc.1 安装里，`ls …/@deepseek-ai | grep client-runtime` 无命中）。补一句精确性：即便留着也不会崩（未知 id 会被静默跳过）——所以这次删除是"消除错误声明"，不是"修复崩溃"。

---

## 3. `lib/` 产物与 `src/` 一致性 + 无 `[DIAG]` 残留（独立确认）

lead 为排查临时改过 `lib/index.js` 并用 `tsdown` 重建还原。我独立验证这次还原是干净的：

```bash
grep -rn "DIAG" lib/                      # → 零命中
```

```bash
# 独立重建：把仓库（除 node_modules/.git/lib）rsync 到 /tmp，软链 node_modules，直接跑 tsdown
rm -rf /tmp/dsh-b-review && mkdir -p /tmp/dsh-b-review
rsync -a --exclude node_modules --exclude .git --exclude lib ./ /tmp/dsh-b-review/repo/
ln -s "$PWD/node_modules" /tmp/dsh-b-review/repo/node_modules
( cd /tmp/dsh-b-review/repo && PATH="$PWD/node_modules/.bin:$PATH" tsdown )   # exit 0
```

比对（归一化掉 `//#region` 里的绝对路径注释）：

```
SAME(norm)  index.js / index.d.ts / client.js
SAME(norm)  agent-instructions.js / .d.ts / agent-instructions-preset.js / .d.ts
SAME(norm)  skill-filesystem.js / .d.ts / skill-filesystem-preset.js / .d.ts
→ 11/11 逐字节相同
```

归一化前只有 4 行差异，全部是构建目录不同导致的路径前缀（`//#region ../../../../Users/…/node_modules/.pnpm/@deepseek-ai+cosmokit@1.8.5/…` vs `//#region node_modules/.pnpm/…`），**不是代码差异**。

发布面同时核对：`exports` 的每个具体目标都存在、`files[]` 含 `lib`/`src`/`cordis.patch.yml`/`locale`、`dsh.bundle.patch` 指向存在的 `cordis.patch.yml`、`lib/client.js` 里唯一裸 `require` 是平台种子词 `react`。

绿线（都在最终树上实跑）：
```
node node_modules/typescript/bin/tsc --noEmit   → exit 0 / 0 error
node scripts/smoke.mjs                          → exit 0 / 31 passed
git diff --check 642bb8e                        → exit 0（无空白错误）
```

---

## 4. 掩盖式修法计数 + 越界改动

### 4.1 掩盖式修法（新增行）→ 全 0

`@ts-ignore` 0、`@ts-expect-error` 0、`@ts-nocheck` 0、`as any` 0、`: any` 0、`<any>` 0、`as unknown as` 0、`!.` 0、`@eslint-disable` 0；删除行里也没有断言/`as` 变动。

### 4.2 越界改动

| 文件 | 可追溯性 | 说明 |
|---|---|---|
| `package.json` | ✅ | peer/dev 范围、删 `dsh-client-runtime`、加 `dsh-llm`、`dsh.client.inject` |
| `pnpm-workspace.yaml` | ✅ 且**无语义倒退** | 见 4.3 |
| `pnpm-lock.yaml`（1319 行） | ✅ | churn 全部来自删掉 devDep `@deepseek-ai/dsh-client-runtime`——`git show 642bb8e:pnpm-lock.yaml` 里该条目把 `dsh-agent@0.1.1-rc.2`、`dsh-llm@0.1.1-rc.2`、`dsh-session@0.1.1-rc.2`、`dsh-api-remotes`、`dsh-host-apiproxy` 等整棵 peer 树带进 lock，删包即删树 |
| `scripts/resolve-dsh-types.mjs` | ✅ | 坑 19 的顺序修复 + 版本 skew 报告 |
| `AGENTS.md` / `README*.md` | ✅ | 坑 18-21 与版本支持表 |

`src/**`、`tsdown.config.ts`、`cordis.patch.yml`、`scripts/smoke.mjs`、`locale/**` 零改动 → **没有与兼容性无关的格式/逻辑改动**。

### 4.3 `pnpm-workspace.yaml` 的 41 行是不是语义倒退 → 不是

用 YAML 解析两侧后比对：

- 顶层键集合**完全相同**（都只有 `minimumReleaseAgeExclude`）。
- **包名集合：旧 19 → 新 34，没有任何包名被删**（`comm -23` 为空），只有 15 个新增。
- 13 个旧条目被改写成 `name@v1 || v2` 形式（范围加宽），其余 6 个原样。
- `name@v1 || v2` 不是笔误：pnpm 11.21 原生支持（`dist/pnpm.mjs:104789 parseVersionPolicyRule` → `:104805 parseExactVersionsUnion` 按 `||` 切分、每段要求 `semver.valid`）。
- **该配置当前是惰性的**：`minimumReleaseAge` 在本机任何一层都没设置（`~/.npmrc`、仓库 `.npmrc`、`pnpm-workspace.yaml`、各父目录），pnpm 默认 `minimumReleaseAge ?? 0`（`dist/pnpm.mjs:105002`）＝ 关闭。所以这批改动既不会帮忙也不会捣乱；**别把"安装成功"归因于它**——成功的原因是 peer 范围写对了。

---

## 5. 三处删除类 API 差异：本包均未使用

| 差异 | 证据位置 | 本包使用情况 |
|---|---|---|
| `modeSelectionEnabled` 从 registry `Config` 移除 | `dsh-agent-preset-registry@0.1.7-rc.1 lib/types/index.d.ts:27,31` → 0.2.0-rc.1 无 | `grep -rn modeSelectionEnabled src/ scripts/ locale/` → **0 命中** |
| `generateConfigSchema(binName, …)` → `generateConfigSchema(…)` | `dsh-app-boot@0.1.7-rc.1 lib/types/config-schema/index.d.ts:19` vs 0.2.0-rc.1 `:18` | **0 命中** |
| `skippedProfileBundles()` 移除，改为 `SkippedBundle` + `reportSkippedBundles()` | `dsh-app-boot@0.1.7-rc.1 lib/types/profile.d.ts:168` vs 0.2.0-rc.1 `:80,91` | **0 命中** |

（三者在 0.2.0-rc.1 均无替代用法需求；`reports/T4-A-api-diff.md` 有完整签名级差分。）

---

## 6. 假绿面

### 6.1 `src/client/index.ts:1` 的 `// @ts-nocheck` —— **既有设计，不是本次引入，不构成应修项**

```
src/client/index.ts:1  // @ts-nocheck — DSH client modules are plain-JS CJS factories; tsc strict applies to the host side.
```

- **既有性**：`git show 642bb8e:src/client/index.ts` 第 1 行就是它，本次该文件**零改动**。
- **注释是否充分**：充分——说明了理由（客户端半边按 CJS factory 形态被 `window.__ModuleLoader__` 装载）与范围（strict 只覆盖 host 侧）。
- **真实后果（要如实说）**：这个约 1100 行的文件**完全不在 `tsc` 覆盖内**。所以"typecheck 0 错误"对客户端半边**不含任何信息**；客户端半边的正确性目前只由 `scripts/smoke.mjs` 的 client 契约渲染检查 + T3 的 F1-F6（模块图/产物被服务）覆盖，两者都不做类型检查。
- **定级：提示**（既有设计 + 有注释）。若要补，建议路径是给客户端 ctx 写一份 ambient 声明 + 文件级打开 `@ts-check`，而不是拆掉这行——那是独立课题，不该塞进兼容性迭代。

### 6.2 `pnpm smoke` 存在盲区（**最强建议**）

`scripts/smoke.mjs:24` 只 `import('../lib/index.js')`，`:458` 只 `import('../lib/client.js')`；两个 session-plane 入口 `lib/agent-instructions-preset.js` / `lib/skill-filesystem-preset.js` **从未被导入或断言**。
T5 的失败模式（external 裸导入不在 `peerDependencies` → linked 层不接管 → 行 never started）**恰好只发生在这两个文件上**，所以 `tsc` 与 `smoke` 当时必然全绿——这不是巧合，是覆盖缺口。
建议把 AGENTS.md 坑 20 的自检固化成 smoke 的一条断言：列出 `lib/*.js` 裸导入，逐个要求 ∈ `peerDependencies` ∪ `dependencies`。**归属 dev（`scripts/smoke.mjs`）**，属测试硬化，不是产品缺陷（真实链路已由 T3 的 C10b/D7 覆盖，但那条要起 profile+服务器）。

**判据的落点（dev 独立复核后与我一致，写进报告以免被误用）**：自查必须跑在**产物**上（`lib/*.js` 的裸导入全集实测 = `@deepseek-ai/cordis`、`@deepseek-ai/dsh-llm`、`chokidar`、`yaml`），**不能**跑在 `RUNTIME_EXTERNALS` 表上——那张表 12 个显式项里有 9 个是 `import type`、被构建擦除（详见 B-5）。表驱动的检查会得到 9 条假阳性，同时仍漏掉 T5（`dsh-llm` 在表里但不在 manifest 里）。

### 6.3 其余两面都不是假绿

- **`tsc`**：`--traceResolution` 确认 `@deepseek-ai/dsh-*` 全部解析到 `~/.local/.../dsh/node_modules/@deepseek-ai/<pkg>/lib/types/index.d.ts`（0.2.0-rc.1），没有静默回退到仓库 node_modules。
- **T3 的 E2E**：`check()` 抛错即记 `fail`（`run-e2e.mjs:74-81`），退出码 `failed.length === 0 ? 0 : 1`（`:1090`）；有 `FORBIDDEN_PROFILES={desktop,web}` / `FORBIDDEN_PORTS={19387}` 守卫（`:42-43,457-458`）并对真实 profile 做前后哈希（E3 全 PASS）。我抽查了三份落盘证据，互相自洽：ON 时 `standard = {overridden:true, rowCount:21, pipeline:true, builtinDisabled:true}` 且 `written:1`；FINAL 时 `{overridden:false, rowCount:19, pipeline:false, builtinDisabled:false}`，patch 里 pipeline 行 0 条、`preset-standard` override 不存在、`presets[].broken` 为空。

---

## 7. 分级问题清单（B 部分）

### 阻断：0 条 ｜ 应修：0 条

### 提示（7 条）

| # | 位置 | 问题 | 建议 |
|---|---|---|---|
| B-1 | `scripts/smoke.mjs:24,458` | 两个 preset 入口零覆盖 → T5 那一类缺陷在快闸门上是盲区 | 把坑 20 的裸导入自检固化为 smoke 断言（**最强建议**） |
| B-2 | `src/client/index.ts:1` | `@ts-nocheck` 使 client 半边不在 tsc 覆盖内 | 既有设计、注释充分，不构成本次问题；另立课题 |
| B-3 | `scripts/resolve-dsh-types.mjs:12-13` | 头部注释仍写旧顺序（"…, this package, then the known `dsh` CLI installation roots"），与 `bases()`（`:80-92`）的 profile → DSH 安装 → 本包 相反 | 改注释（这正是坑 19 要防的误导） |
| B-4 | `scripts/resolve-dsh-types.mjs:88-89` | 注释引用函数名 `reportVersionSkew`，文件里没有这个函数（实现是 `:146-150` 内联 `skew`） | 改注释 |
| B-5 | `tsdown.config.ts:47` | `RUNTIME_EXTERNALS` 仍列已删除的 `@deepseek-ai/dsh-client-runtime`（当前无害：无 src 引用、产物无对应 import） | 顺手删除。**但判据必须落在产物上、不是这张表上**——我实测该表 12 个显式项里只有 3 个（`dsh-llm`/`chokidar`/`yaml`）真的出现在 `lib/*.js`，其余 9 个（`dsh-agent`/`dsh-fs`/`dsh-session`/`dsh-tools`/`dsh-home-paths`/`dsh-agent-preset`/`dsh-agent-preset-registry`/`dsh-skill`/`dsh-client-runtime`）在 `src/` 里都是 `import type`、构建时被擦除。把类型专用的 external 当成"必须在 peer 里点名"会得到 9 条假阳性；反过来只看表也会漏掉 T5（`dsh-llm` 在表里、却不在 manifest 里）。**唯一正确判据 = `lib/*.js` 的裸导入 ⊆ `peerDependencies` ∪ `dependencies`。**（dev 独立复核后提出同一结论，双方一致） |
| B-6 | `scripts/e2e/reports/` | 39 个文件 / 484K 原始证据（server log、install log、diag dump）默认会被提交；`.gitignore` 只忽略 `.tmp/` | 只留 `*.md`/`*.json` 摘要，或收窄 `.gitignore` |
| B-7 | `README.md` / `README.zh-CN.md` 版本表 | 新加三行与旧的 `0.1.7-alpha.2 及以后 ✅ 设计目标` 语义重叠 | 合并或改成"能力面（与版本线无关）" |

补充两条给文档的精确化建议（不单列）：`AGENTS.md` 坑 18 引用的 `dsh-app-boot/lib/index.js:251-315` 里，函数实际从 `:286` 起、判定在 `:294`/`:300`（区间包住了，够用）；坑 21 说"`presets[].broken` 是唯一信号"是准确的，但要注意 `broken` 只在**行有 fiber 但导入/依赖失败**时出现——见坑 20 的 `never started` 语义。

---

## 8. 「我尝试证伪但未能证伪」的记录

1. **想证伪"`lib/` 与 `src/` 一致"**（lead 承认临时改过 `lib/index.js`）：独立重建 + 归一化比对 → 11/11 相同、`grep DIAG lib/` 零命中 → **证伪失败：还原干净。**
2. **想证伪"lockfile 没有越界 churn"**：`git show 642bb8e:pnpm-lock.yaml` 的 `dsh-client-runtime@0.1.1-rc.2` 条目把十几个 dsh 包带进 lock → 1319 行 churn 全部可解释 → **证伪失败。**
3. **想证伪"`pnpm-workspace.yaml` 那 41 行有语义倒退"**：YAML 解析两侧，顶层键相同、**包名集合只增不减**（19→34，`comm -23` 为空）→ **证伪失败：无倒退**（但这批配置当前惰性，见 4.3）。
4. **想证伪"`dsh.client.inject` 的处理得当"**：两个方向的直觉都被推翻——删掉的 `dsh-client-runtime` 留着也不会崩（未知 id 静默跳过），而保留的 `dsh-client-ui-slots` **根本不是 client graph row**（无 `dsh.client`、无 `./client`），所以它**不提供顺序保证**；真正的保证是 renderer 的 `immediately: true`。结论：保留无害，但 F5 那条断言恒真、抓不到这类问题 → **双向证伪，见第 2 节。**
5. **想证伪 T3 的 E2E 是"脚本自嗨"**：读 `check()/assert()`/退出码/守卫 + 抽查三份原始证据（ON 状态、FINAL 状态、ON 前后的 patch）互相印证 → **证伪失败。**
6. **想证伪"peer 范围覆盖 0.2.0 稳定版"**：DSH 自带 semver 7.8.5 + `includePrerelease:true`，6 个版本 × 5 个 peer → 全对（0.1.6/0.3.0 正确为 UNSAT）→ **证伪失败。**
7. **想找出 dev 漏改的 src 契约**：`git status` 显示 `src/**` 零改动，`tsc` 0 错误、`smoke` 31/31；结合 T4-A 的独立差分（19 符号、12 服务键、6 事件、4 个 shipped 预设逐字节相同、两个被替代内建逐字节相同）→ **找不到任何必须适配的漂移**。

**唯一确凿的问题都在产品面之外**（文档不一致、测试盲区、惰性配置、证据体积、既有 `@ts-nocheck`）。产品代码在冻结树上是绿且自洽的。

---

## 9. 对 T2 / T3 的独立背书与保留

**T2（dev）——背书 "`src/` 零改动，无漂移"**
- 事实：最终树 `git status` 里**没有 `src/**`**，`tsdown.config.ts`、`cordis.patch.yml`、`scripts/smoke.mjs` 同样零改动。
- 我独立跑出同样的绿：`tsc --noEmit` exit 0 / 0 error；`node scripts/smoke.mjs` exit 0 / 31 passed（**注意这两条绿的含义不同**：host 侧真被校验，client 侧被 `@ts-nocheck` 排除，见 6.1）。
- 与我 T4-A 的差分结论一致：静态面 21 包全量比对、动态面 12 服务/6 事件/4 预设/2 个被替代内建全部一致 → **不存在需要适配的 API 漂移**。所以"T2 不改代码"是正确结论，不是遗漏。
- 保留：我看到的是一份我未读到的审计报告；我能背书的是"工作树状态与结论相符"。

**T3（tester）——背书，附一条作用域保留**
- 背书：45 条断言全 PASS；`check()`/退出码/守卫/证据链我都核过（6.3）。`presets[].broken` 在 ON / OFF 两侧都为空，正是 T5 缺陷的**唯一**可见信号，被覆盖到了；C12（`expectedRevision` 不符会被拒）那条尤其有价值——它正是 lead 误判"释放失败"的陷阱。
- **保留（作用域，不是错误）**：全部证据来自 **`link:` 安装 + scratch profile**。用户桌面 profile 走的是 **registry 安装**（`~/.dsh/profiles/desktop/package.json:12` = `"@sidleo3/dsh-plugins-plus": "^0.1.1"`，`node_modules/@sidleo3/dsh-plugins-plus` 是真目录），那条路径不经过 linked 层路由，机制上不受坑 20 影响，但**本轮没有实测**。所以 E2E 通过 ≠ registry 安装路径也被本轮修复验证过。
- 附：F5 的鉴别力问题见第 2 节。

**T5 的归属（呼应 lead 的判定要求，已单独回复）**：linked 层路由（`routeLinked`/`readPeerNames`）在 `0.1.7-rc.1` 就存在且 `routeLinked` 函数体逐字节相同；`evaluatePluginCompatibility` 也是 0.1.7 就导出的。所以 T5 是**既有缺陷**（在 `link:` 安装路径上 0.1.x 同样 never started），本轮因 E2E 走 `link:` 而暴露并顺带修复——**不是 0.2.0 的回归**。

---

## 10. 覆盖面 / 未覆盖面

**已覆盖**：diff 全量（7 个 tracked 文件 + 2 个交付目录）、掩盖式修法计数、peer 真 semver 矩阵 + 真闸门函数、`dsh.client.inject` 双侧判定（含 graph row 机制）、externals ↔ 产物裸导入 ↔ manifest 三方对齐、`lib/` 与 `src/` 重建一致性 + DIAG 残留、发布面（exports/files/bundle patch）、tsc 解析落点、smoke 覆盖分析、E2E 断言与证据链抽查、测试守卫、pnpm 配置语义与惰性判定、`@ts-nocheck` 覆盖缺口。

**未覆盖**：GUI 页面的真实视觉/交互（只验证到模块图与产物被服务，没有浏览器渲染验证——客户端半边无类型检查，最终仍靠人眼）；`npm publish` 流程本身；0.1.7 运行时上的回归复测（本机已无 0.1.7 安装）；registry 安装路径的 E2E；`scripts/e2e/run-deny-check.mjs` 的 9 条断言只读了守卫与退出码，未逐条重跑（需要刻意造出"peer 不兼容的已安装插件"状态）。

---

## 11. 复现命令

```bash
cd <repo> && export PATH="$HOME/.local/bin:$PATH"

# 闸门 + 真 semver
node --input-type=module -e "
import { readFile } from 'node:fs/promises'
import { evaluatePluginCompatibility, getDshRuntimeVersion } from '$HOME/.local/lib/node_modules/@deepseek-ai/dsh/node_modules/@deepseek-ai/dsh-app-boot/lib/index.js'
const m = JSON.parse(await readFile('package.json','utf8'))
console.log(getDshRuntimeVersion(), evaluatePluginCompatibility(m) === undefined ? 'PASS' : 'REJECT')"
S=$HOME/.local/lib/node_modules/@deepseek-ai/dsh/node_modules/semver
node -e "const s=require('$S');for(const v of ['0.1.6','0.1.7-rc.1','0.1.7-rc.2','0.2.0-rc.1','0.2.0','0.3.0'])
  console.log(v, s.satisfies(v,'^0.1.7-alpha.2 || ^0.2.0-rc.1',{includePrerelease:true}))"

# 掩盖式修法计数 / 越界
git diff 642bb8e | grep -E '^\+' | grep -cE '@ts-ignore|@ts-expect-error|as any|: any|@ts-nocheck|@eslint-disable'
git diff --check 642bb8e
git diff --stat 642bb8e

# 产物裸导入 ↔ manifest
grep -ho 'from "[^".][^"]*"' lib/*.js | sed 's/from "//;s/"//' | grep -v '^node:' | sort -u
grep -rn "DIAG" lib/ ; echo "DIAG hits: $?"

# lib/ 与 src/ 一致性（不污染仓库；见第 3 节完整脚本）
rsync -a --exclude node_modules --exclude .git --exclude lib ./ /tmp/dsh-b-review/repo/
ln -s "$PWD/node_modules" /tmp/dsh-b-review/repo/node_modules
( cd /tmp/dsh-b-review/repo && PATH="$PWD/node_modules/.bin:$PATH" tsdown )

# client inject 是 graph row 吗
node -e "const j=require('$HOME/.local/lib/node_modules/@deepseek-ai/dsh/node_modules/@deepseek-ai/dsh-client-ui-slots/package.json');console.log('dsh field:', j.dsh, '| exports:', Object.keys(j.exports))"

# 绿线
node node_modules/typescript/bin/tsc --noEmit ; echo "tsc=$?"
node scripts/smoke.mjs ; echo "smoke=$?"
```

---

# 定稿后增量复核（第二轮，覆盖新树）

> 触发：定稿后 lead 采纳 B-5、dev 改了 `tsdown.config.ts` 与 `scripts/smoke.mjs`；lead 自己改了 `scripts/resolve-dsh-types.mjs` 注释与 `.gitignore`；`package.json` 只改 `version` → `0.1.6`。
> 结论：**仍是「兼容、无阻断、无应修」**。新增 6 条提示（全部为判据边界与文档口径），无一条影响本轮发布。

## 增量一：新树的 re-baseline（我重跑的，不是引用）

| 项 | 结果 |
|---|---|
| `tsc --noEmit` | exit 0 / 0 error |
| `node scripts/smoke.mjs` | exit 0 / **32 passed / 0 failed**（新增那条 `every built import is a declared dependency` ✓） |
| `tsdown`（在 /tmp 副本、新配置下） | exit 0，**6 个产物**；与仓库 `lib/` **11/11 归一化后逐字节相同**；`grep DIAG lib/` 零命中 |
| 闸门（真函数） | runtime `0.2.0-rc.1` → **PASS**；`dsh.client.inject` 仍为 `["@deepseek-ai/dsh-client-ui-slots"]` |
| peer 矩阵（5 个 dsh peer） | 0.1.6 **F** / 0.1.7-rc.1 T / 0.1.7-rc.2 T / 0.2.0-rc.1 T / 0.2.0 T / 0.3.0 **F** —— 与上轮完全一致 |
| `src/`、`cordis.patch.yml`、`locale/` | **零改动**（`git diff --stat 642bb8e -- src/ cordis.patch.yml locale/` 为空） |
| 掩盖式修法（新增行） | 仍全 0 |
| `resolve-dsh-types.mjs` | 剥注释后逐行比较：**代码面无新增差异**（差异全是注释文本）；/tmp 副本实跑 → `13/13 resolved`、`dsh runtime: 0.2.0-rc.1`、无 skew 警告、13 条全部来自运行时安装 |
| 越界 | tracked 文件 7 → 10（新增 `.gitignore`、`scripts/smoke.mjs`、`tsdown.config.ts`），三者都直接对应我上轮的点名项，**无越界** |
| **修正上轮的一处口径** | 上轮我写"产物裸导入全集 = 4 条"是**只算 host 半边**。完整口径 = **5 条 / 5 包**：`@deepseek-ai/cordis`(lib/index.js)、`@deepseek-ai/dsh-llm`(lib/agent-instructions-preset.js)、`chokidar`+`yaml`(lib/skill-filesystem-preset.js)、**`react`(lib/client.js)**。dev 指出后我实测确认，新断言也确实扫到了 client 半边（见下） |

## 增量二：新断言的对抗性验证（我自己构造的 6 个探针）

**有牙（2 个方向都验证了）**

```
# A. 副本里删掉 @deepseek-ai/dsh-llm 的 peer → 期望 FAIL
  ✗ every built import is a declared dependency
  1 check(s) failed, 31 passed   exit=1
# B. 副本里删掉 react 的 peer → 期望点名 client 半边
  + [ '@deepseek-ai/dsh-llm (lib/agent-instructions-preset.js)', 'react (lib/client.js)' ]   exit=1
```
→ 两个方向都成立，且第二条证明 `lib/client.js` **确实在扫描范围内**（dev 的说法属实）。

**判据的 3 个已证实边界（都是提示级，今天都不触发）**

| # | 探针（在 /tmp 副本里往 `lib/` 丢一个合成文件） | 期望 | 实测 | 判定 |
|---|---|---|---|---|
| **C-1a** | `lib/zz-probe-d.js` = `import "zz-undeclared-side-effect";` | 应 FAIL | **exit 0（漏扫）** | 正则 `(?:\bfrom\s*\|\bimport\s*\(\s*\|\brequire\s*\(\s*)["']` 不认**副作用导入**（无 `from`、无括号）。当前产物无此形态。修法：alternation 里加 `\bimport\s*` |
| **C-1b** | `lib/zz-probe-e.js` = `import x from "file:///tmp/whatever.js";` | 不应报 | **exit 1（假阳性）** | 过滤器只排除 `./`、`../`、`/`、`node:`；带 scheme 的说明符被当成包名。修法：改为排除 `/^[a-z][a-z0-9+.-]*:/` |
| **C-1c** | `lib/zz-probe-g.js` = `require("react-dom"); require("react/jsx-runtime");` | 不应报 | **exit 1，仅点名 `react-dom`** | 客户端半边的 `require` 由**平台种子**（`staticModules`）提供、不走 node_modules；种子里有 `react-dom`/`react/jsx-runtime` 等，而 manifest 只声明了 `react`。注意 `react/jsx-runtime` 因包名归并成 `react` 而安全，**只有"种子词且包根未声明"才会假阳性**（如 `react-dom`）。今天不触发（client 只 require `react`） |

**没问题的三处（也验了）**

- **未构建时不会静默通过**：删掉 `lib/` 后 smoke 在 `smoke.mjs:24` 就 `ERR_MODULE_NOT_FOUND`、exit 1 —— 这是既有设计（`smoke.mjs:4` 明写"runs against the BUILT bundle"），**不是新增失败面**。
- **子路径归并正确**：`@scope/pkg/sub` → `@scope/pkg`、`pkg/sub` → `pkg`（探针 F1/F2 均 exit 0，通过）。
- **防空扫护栏有效**：`assert.ok(imports.length > 0, 'no built import was scanned — the check is reading the wrong files')` 存在，避免"扫不到文件反而绿"。

**稳健性附注**：扫描用 `readdirSync('../lib')` **非递归**；当前 `lib/` 是扁平目录，够用；将来若出现 `lib/chunks/*.js` 之类会漏扫。

## 增量三：关闭情况

| 上轮提示 | 状态 |
|---|---|
| B-1（smoke 覆盖不到 preset 入口） | ✅ **关闭**（新断言；我复现了正/反两个方向，32/32） |
| B-2（`src/client/index.ts:1` 的 `@ts-nocheck`） | ⏸ **有意未动**——需要改 `src/` 且不属兼容性迭代，留作独立课题（正确决定） |
| B-3（`resolve-dsh-types.mjs` 头部注释旧顺序） | ✅ 关闭（注释已改为 profile → 运行安装 → 本包） |
| B-4（注释引用不存在的 `reportVersionSkew`） | ✅ 关闭（改为引用内联的 `skew`） |
| B-5（`RUNTIME_EXTERNALS` 残留 + 判据落点） | ✅ 关闭（条目已删；JSDoc 固化了"约束落在产物上"） |
| B-6（`scripts/e2e/reports/` 会被提交） | ✅ 关闭，**附一条副作用**（见 C-4） |
| B-7（README 版本表新旧行重叠） | ⏸ **仍未处理**（`0.1.7-alpha.2 及以后 ✅ 设计目标` 那行还在） |

## 增量四：本轮新发现的提示（6 条，全部提示级）

| # | 位置 | 现象 | 建议 |
|---|---|---|---|
| **C-1a** | `scripts/smoke.mjs`（新断言的正则） | 副作用导入 `import "pkg"` 漏扫（实测 exit 0） | alternation 加 `\bimport\s*` |
| **C-1b** | 同上（过滤器） | 带 scheme 的说明符（`file:`/`data:`/`http:`）被判成包名 → **假阳性**（实测 exit 1） | 排除 `/^[a-z][a-z0-9+.-]*:/` 而非只排除 `node:` |
| **C-1c** | 同上（扫描范围含 client 半边） | 平台种子词（如 `react-dom`）会被判成缺依赖 → **假阳性**（实测 exit 1） | 加种子词白名单，或在 manifest 里补声明 |
| **C-2** | `AGENTS.md:93` | 仍写「`tsdown.config.ts:RUNTIME_EXTERNALS` 里每一项都要在这条自检里对得上」——与 `tsdown.config.ts` 新 JSDoc、新 smoke 断言、以及 B-5 的精确化结论**方向相反**（该表 12 项里 9 项是 type-only、压根不进产物）。下一句虽然补了"类型专用的包会被擦除"，但第一句仍是表驱动口径 | 改成"**产物里的每条裸导入都要在 manifest 里点名**；表里可以留 type-only 项（构建期擦除）" |
| **C-3** | `AGENTS.md:33`、`AGENTS.md:43` | smoke 计数仍是 **31**，实际 **32** | 改成 32 |
| **C-4** | `.gitignore:12` | `scripts/e2e/reports/` 整目录被忽略 → tester 的**摘要报告**（`postfix-report.md`、`baseline-vs-postfix.md`、`deny-check-report.md`）**也不入库**（`git check-ignore -v` 已确认）。若这些摘要是本轮证据交付物，就不该被忽略。另 `scripts/e2e/.tmp/` 与 `scripts/e2e/.gitignore` 里的同一条重复（无害） | 改为忽略 `*.log`/`*.json`/`*.txt` 而放行 `*.md`，或把摘要挪进 `reports/` |

**结论**：三处改动（`tsdown.config.ts`、`scripts/smoke.mjs`、`package.json`）与 lead 的两处（`resolve-dsh-types.mjs` 注释、`.gitignore`）**均未引入阻断或应修问题**；本轮所有发现都是提示级，且集中在**新断言的判据边界**（C-1a/b/c）与**文档口径**（C-2/C-3）上。上一轮的"兼容、无阻断、无应修"结论维持。
