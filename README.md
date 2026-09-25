# @sidleo3/dsh-plugins-plus

[English](README.md) | [中文](README.zh-CN.md)

One DeepSeek Harness (DSH) bundle that ships **independently switchable components**, each replacing a built-in plugin per **agent preset**. Configuration lives in **DSH Settings**.

| Component (Loader row id) | Replaces | What it does |
|---|---|---|
| `dsh-plugins-plus` | — | Core row: owns the single configuration schema, the takeover engine, and the read-only status API |
| `agent-instructions-plus` | `agent-instructions` | AGENTS.md injection: four scan layers (cwd / project / every ancestor / global) with editable file names and budgets |
| `skill-filesystem-plus` | `skill-filesystem` | Skill discovery: four scan layers plus editable, orderable parent-directory names |

Component naming rule: **built-in row id + `-plus`**. Adding a component later means one more export, one more `cordis.patch.yml` row, one schema section and one UI section — no new package, nothing to install twice.

---

## Install

```bash
# from npm (recommended)
dsh plugin --profile <profile> add @sidleo3/dsh-plugins-plus

# from a local checkout (development)
dsh plugin --profile <profile> add link:/path/to/dsh-plugins-plus
```

Restart DSH afterwards. Installation itself changes nothing: only the core row is enabled by default, both component rows ship `disabled: true`.

## Switch components on

Sidebar **Plugins** → the `DSH Plugins Plus` card → flip the row switch of the component you want.

- Turning `skill-filesystem-plus` on makes the engine disable the built-in `skill-filesystem` row inside the selected presets and append this bundle's discovery row.
- Turning it off undoes exactly that; the built-in implementation returns, and DSH deletes the override row entirely once the composition equals the shipped layer again.

## Configure (Settings → DSH Plus)

One page, three entry points, the same UI:

| Entry point | Where |
|---|---|
| **Settings → DSH Plus** | a first-class settings section (recommended) |
| Sidebar **Plugins** → this bundle's card | `plugins.bundle.config` |
| Sidebar **Plugins** → a component row's **Configure** | `plugins.row.config`, keyed `<package>#<row id>` |

The page offers a **global** preset selection every component inherits, one card per component (inherit the global selection or pick its own, plus that component's parameters), the live takeover state of every preset, and a scan-root preview.

Writes go through DSH's own pipeline (`ctx.configForms` → settings → config editor → the profile's `cordis.patch.yml`):

- configuration lives in the **profile patch** under the core row; this bundle keeps no settings file of its own;
- every field keeps inheritance semantics — "restore default" is an `unset`, falling back to the schema default;
- saving applies immediately; the core row is not remounted (its fields are volatile).

> A session fixes its preset composition when it is created, so takeover changes affect **sessions created afterwards**.

## Differences from the built-ins

| Dimension | Built-in | This bundle |
|---|---|---|
| Scope | every preset | only the presets you select (global selection may mean "all") |
| Upward scan | stops at the project root (`.git`) | `scanProject` or `scanParents` (up to `/`), mutually exclusive |
| cwd / global layer | fixed | independent switches |
| Skill parent directories | fixed | add, edit, remove, reorder |
| Configuration | a JSON file per plugin | DSH Settings (profile patch) |

## Migrating from the two standalone plugins

The old packages are `@sidleo3/agent-instructions-plus` and `@sidleo3/skill-filesystem-plus`.

```bash
dsh plugin --profile <profile> add @sidleo3/dsh-plugins-plus
dsh plugin --profile <profile> remove @sidleo3/agent-instructions-plus
dsh plugin --profile <profile> remove @sidleo3/skill-filesystem-plus
# restart DSH
```

On the next start the engine performs these steps once, recording the import as a `legacyImport` timestamp in its own configuration:

1. fields from `~/.dsh/dsh-instruction-scan.json` and `~/.dsh/dsh-skill-filesystem-plus.json` that the profile does not declare yet are imported into `components.*`;
2. presets the old wizards had already taken over are adopted as that component's preset selection (`useGlobalPresets: false` plus the list);
3. earlier releases' pipeline rows (`*-plus-pipeline` and their old module names) are rewritten in place, never duplicated.

> The legacy JSON files are **left untouched**: they live in the shared `~/.dsh`, where another profile may still run the old plugins. Delete them yourself once you are sure.

## Compatibility

| DSH version | Status |
|---|---|
| `0.1.7-rc.2` | ✅ the baseline this release was developed and verified against |
| `0.1.7-alpha.2` and later | ✅ design target (`settings.section`, `plugins.bundle.config`, `plugins.row.config`, `ctx.configForms`, `ctx.configEditor`, `agentPresets.compositionInventory`) |

Everything version-sensitive is kept in `src/core/` (`composition.ts`, `takeover.ts`, `hmr.ts`, `rpc.ts`) so a future DSH change has one obvious place to look.

## Development

```bash
pnpm install --ignore-scripts
pnpm resolve-types     # resolve @deepseek-ai/* types from the RUNNING DSH install (.dsh-types/, gitignored)
pnpm typecheck         # expect 0 errors
pnpm build             # tsdown → lib/{index,agent-instructions,skill-filesystem,*-preset,client}.js
pnpm smoke             # 28 checks: schema, inheritance, takeover planning, migration, client contract
```

Release checklist:

```bash
pnpm typecheck && pnpm build && pnpm smoke
grep -c 'plugins.bundle.config' lib/client.js            # >= 1: the bundle configuration page is registered
head -c 80 lib/client.js | grep -c '__ModuleLoader__'    # 1: the client half is a CJS factory
grep -rn 'from "\./.*\.d\.ts"' lib/*.js                  # 0 lines: no type file is imported at runtime
```

## License

MIT
