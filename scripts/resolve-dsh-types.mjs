/**
 * Generate `tsconfig` paths for the DSH runtime type packages.
 *
 * `src/` imports TYPES from `@deepseek-ai/dsh-*`, `@deepseek-ai/cordis` and
 * `@deepseek-ai/schemastery`, but the running DSH installation is the only
 * place where every package exists at the version that actually executes
 * (the registry carries stale `rc`/`alpha` builds that may drift from the
 * installed runtime). Resolving from the RUNNING installation keeps the type
 * check honest — without it `tsc` reports "Cannot find module" noise that
 * masks real errors (see AGENTS.md pitfall 9 in agent-instructions-plus).
 *
 * Resolution order: the active profile (DSH sets `DSH_PROFILE_DIR`), the
 * running `dsh` installation, and only then this package as a fallback —
 * see {@link bases} for why the installation must beat the local
 * `node_modules`.
 *
 * Run it before `tsc` (and after switching DSH installs):
 *   node scripts/resolve-dsh-types.mjs
 *
 * @module scripts/resolve-dsh-types
 */

import { createRequire } from 'node:module'
import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

/**
 * Packages `src/` imports TYPES from (client-only packages ship no host types).
 *
 * `@deepseek-ai/schemastery` is deliberately absent: `src/` imports it for its
 * RUNTIME (`z.object(...)`), so mapping it to the running installation's
 * `lib/types/index.d.ts` would make the bundler resolve a value import to a
 * declaration file and emit `import ... from "./chunk.d.ts"` — a module that
 * does not exist at runtime. It is installed as a devDependency, which is where
 * both its types and its JavaScript come from.
 *
 * Every package listed here is either imported with `import type` only or kept
 * external by `tsdown.config.ts`, so a declaration-only path is safe for them.
 */
const PACKAGES = [
  '@deepseek-ai/cordis',
  '@deepseek-ai/cordis-plugin-loader',
  '@deepseek-ai/dsh-agent',
  '@deepseek-ai/dsh-agent-preset',
  '@deepseek-ai/dsh-agent-preset-registry',
  '@deepseek-ai/dsh-config-editor',
  '@deepseek-ai/dsh-fs',
  '@deepseek-ai/dsh-home-paths',
  '@deepseek-ai/dsh-llm',
  '@deepseek-ai/dsh-session',
  '@deepseek-ai/dsh-settings',
  '@deepseek-ai/dsh-skill',
  '@deepseek-ai/dsh-tools',
]

const packageRoot = dirname(dirname(fileURLToPath(import.meta.url)))

/** Installed `dsh` package directories, most specific first. */
function dshInstallRoots() {
  const roots = []
  const localBin = join(homedir(), '.local', 'lib', 'node_modules')
  roots.push(join(localBin, '@deepseek-ai', 'dsh'))
  roots.push(join('/usr', 'local', 'lib', 'node_modules', '@deepseek-ai', 'dsh'))
  for (const globalRoot of [join(homedir(), '.npm-global', 'lib', 'node_modules'), '/opt/homebrew/lib/node_modules']) {
    roots.push(join(globalRoot, '@deepseek-ai', 'dsh'))
  }
  return roots.filter(root => existsSync(join(root, 'package.json')))
}

/**
 * Resolution bases, most specific first.
 *
 * The installation that RUNS comes before this package's own `node_modules`.
 * Ordering the other way around silently checks the source against whatever
 * devDependency happens to be installed — a `^0.1.7` pin then reports the
 * 0.1.7 API as green while the runtime serves 0.2.0, which is exactly how a
 * version bump escapes a type check. The active profile stays first because
 * `dsh` sets it and a profile may legitimately pin its own copy.
 */
function bases() {
  const list = []
  // The active profile is the real runtime environment: `dsh` sets this.
  if (process.env.DSH_PROFILE_DIR) {
    list.push(join(process.env.DSH_PROFILE_DIR, 'package.json'))
  }
  // The `dsh` installation that actually executes the plugin.
  for (const root of dshInstallRoots()) list.push(join(root, 'package.json'))
  // Last resort: a hoisted install inside this package. The `skew` check below
  // warns when this fallback resolves a package the installation also carries.
  list.push(join(packageRoot, 'package.json'))
  return list
}

/** Candidate type entry points inside one resolved package directory. */
function typeEntries(dir) {
  return [
    join(dir, 'lib/types/index.d.ts'),
    join(dir, 'lib/types/index.d.mts'),
    join(dir, 'dist/types/index.d.ts'),
    join(dir, 'index.d.ts'),
  ]
}

const paths = {}
const missing = []
const resolvedFrom = {}
const versions = {}
for (const pkg of PACKAGES) {
  let resolved = false
  for (const base of bases()) {
    let manifest
    try {
      manifest = createRequire(base).resolve(`${pkg}/package.json`)
    } catch {
      continue
    }
    const dir = dirname(manifest)
    const entry = typeEntries(dir).find(candidate => existsSync(candidate))
    if (entry === undefined) continue
    paths[pkg] = [entry]
    resolvedFrom[pkg] = dir
    versions[pkg] = { version: JSON.parse(readFileSync(manifest, 'utf8')).version, dir }
    resolved = true
    break
  }
  if (!resolved) missing.push(pkg)
}

/** The version of the `dsh` installation that runs the plugin, or undefined. */
const runtimeVersion = (() => {
  for (const root of dshInstallRoots()) {
    try {
      return JSON.parse(readFileSync(join(root, 'package.json'), 'utf8')).version
    } catch {
      continue
    }
  }
  return undefined
})()

/**
 * `@deepseek-ai/dsh-*` releases move in lockstep with the runtime, so a
 * resolved type package at another version means the check is reading an API
 * the running installation does not serve. Report it instead of passing green.
 */
const skew = runtimeVersion === undefined
  ? []
  : Object.entries(versions).filter(([pkg, info]) =>
      pkg.startsWith('@deepseek-ai/dsh-') && pkg !== '@deepseek-ai/dsh-home-paths' && info.version !== runtimeVersion,
    )

/**
 * `@deepseek-ai/dsh-plugin-manager` and friends are reached through Loader
 * rows only; nothing in `src/` imports them at type level. The list above is
 * deliberately limited to what the source actually names.
 */
const outDir = join(packageRoot, '.dsh-types')
mkdirSync(outDir, { recursive: true })
writeFileSync(
  join(outDir, 'tsconfig.paths.json'),
  JSON.stringify({ compilerOptions: { paths } }, null, 2) + '\n',
)

console.log(`resolve-dsh-types: ${Object.keys(paths).length}/${PACKAGES.length} resolved`)
if (runtimeVersion !== undefined) console.log(`  dsh runtime: ${runtimeVersion}`)
const distinctRoots = [...new Set(Object.values(resolvedFrom).map(dir => dir.replace(/\/node_modules\/.*$/, '')))]
for (const root of distinctRoots) console.log(`  from ${root}`)
for (const [pkg, info] of skew) {
  console.warn(`  version skew: ${pkg}@${info.version} (runtime is ${runtimeVersion}) — types no longer match the running DSH`)
  console.warn(`    resolved from ${info.dir}`)
}
if (missing.length > 0) {
  // Not fatal: a missing package only means the error for it stays a
  // "Cannot find module" instead of a real diagnostic.
  console.warn(`  unresolved (types unavailable): ${missing.join(', ')}`)
}

/** Report a stale install early instead of letting tsc surface a wall of noise. */
if (existsSync(join(packageRoot, 'node_modules', '@deepseek-ai'))) {
  const installed = readdirSync(join(packageRoot, 'node_modules', '@deepseek-ai'))
  if (installed.length === 0) console.warn('  node_modules/@deepseek-ai is empty — run pnpm install')
}
