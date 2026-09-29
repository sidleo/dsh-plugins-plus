# scripts/e2e — 真实链路验证

这些脚本在**一次性 scratch profile** 上跑真实 DSH：link 安装 → 后台启动 → 取 token/cookie → 调真实 remote → 断言 profile patch 落盘 → 组件开关 → 释放还原 → 清理进程。单元测试（`pnpm smoke`）与只看 patch 文件都会漏掉接线问题（AGENTS.md 坑 12/20/21），这里就是防线。

```bash
export PATH="$HOME/.local/bin:$PATH"     # node / pnpm / dsh 都在 ~/.local/bin

node scripts/e2e/run-e2e.mjs                                   # 主链路，干净起点，45 项断言
node scripts/e2e/run-e2e.mjs --phase leftover --keep-profile    # 升级路径：起点已带 override
node scripts/e2e/run-e2e.mjs --no-install                       # 跳过安装（已装好时更快）
node scripts/e2e/run-e2e.mjs --port 5399 --preset standard      # 端口 / 被接管的预设
node scripts/e2e/run-deny-check.mjs                             # 复现加载期 compatibility deny
```

- 退出码：`0` 全通过、`1` 有断言失败、`2` 拒绝运行（守卫 / 前置不满足）。
- 产物都在 `reports/`：`<phase>-report.md|json`（逐断言 + 原始证据）、`*-patch-*.yml`、`*-status-*.json`、`*-server.log`、`*-install.log`。
- **安全**：拒绝 desktop / web 两个真实 profile 与 19387 端口；每轮对这两个 profile 的状态文件做前后哈希比对；只写 `scripts/e2e/**` 与 `~/.dsh/profiles/<scratch>/**`。
- **清理**：`SIGTERM` → 轮询等进程真正退出 + 端口真正释放（超时升 `SIGKILL`），异常与信号路径共用同一 finally；结束时断言无残留进程。

`run-deny-check.mjs` 会用 `git show 642bb8e:package.json` 造一份 pre-fix manifest（软链到当前 `lib/`），先证明安装闸门拒绝、再用 DSH 自己的 exact-version 豁免装上、然后**撤销豁免**回到用户真实状态（装着、无豁免）→ 启动抓到 `dsh: skipping profile bundle …` 与 404 / namespace 缺失，最后恢复 profile（重装当前仓库、撤销豁免、比对 patch）。

## 断言分组

| 组 | 覆盖 |
|---|---|
| G | 守卫、构建产物新鲜度（`lib/` 是否比 `src/` 新）、起点是否干净（open→close 路径是否真的被覆盖） |
| A | link 安装、profile 依赖与 bundle 选择、`dsh plugin list` 告警、DSH 自己的 `evaluatePluginCompatibility` 判据 |
| B | 后台启动、token、cookie、无 cookie 401、启动日志无 deny 行、post-boot patch 快照 |
| C | `settings/describe`（`applies: live`/`autoGenerate: false`）、entry id 形态、`settings/mutate` 写盘、`pluginManager/setPluginEnabled`、只读路由、revision 守卫、`presets[].broken` |
| D | 释放接管、组件关闭、无 `disabled: false` 残留、无 preset 覆盖、无 broken、场景自证 |
| E | 进程/端口清理、真实 profile 零副作用 |
| F | 客户端模块图：`window.__DSH_BOOT__`、我们的 entry、`/plugins/...` 200 + 自身代码标记、batch 全 200、`dsh.client.inject` 存在性、产物裸 require |

## 注意

- **必须在没有其它 dsh 占用同一 profile / 端口时运行**：脚本会拒绝占用中的端口，并会中止同 profile 的并发运行（同一 profile 的 patch 只能有一个写入者）。
- 默认 `--reset`（起点 patch 若带旧接管覆盖会被清成 pristine，原内容归档到 `reports/<phase>-pre-run-patch.yml`）。这是**测试前置**，不是结果粉饰：脚本在结束前不做任何手工还原，最终 patch 完全由 DSH 与插件写出。
- 只在 `link:` 安装形态下有效（`dsh plugin add link:$PWD`）。
