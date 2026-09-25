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
 * Resolution order: the active profile (DSH sets `DSH_PROFILE_DIR`), this
 * package, then the known `dsh` CLI installation roots.
 *
 * Run it before `tsc` (and after switching DSH installs):
 *   node scripts/resolve-dsh-types.mjs
 *
 * @module scripts/resolve-dsh-types
 */

import { createRequire } from 'node:module'
import { existsSync, mkdirSync, readdirSync, writeFileSync } from 'node:fs'
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

/** Resolution bases, most specific first. */
function bases() {
  const list = []
  // The active profile is the real runtime environment: `dsh` sets this.
  if (process.env.DSH_PROFILE_DIR) {
    list.push(join(process.env.DSH_PROFILE_DIR, 'package.json'))
  }
  // Fall back to this package, which works for a hoisted install.
  list.push(join(packageRoot, 'package.json'))
  // Finally the `dsh` CLI installation's own node_modules.
  for (const root of dshInstallRoots()) list.push(join(root, 'package.json'))
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
    resolved = true
    break
  }
  if (!resolved) missing.push(pkg)
}

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
const distinctRoots = [...new Set(Object.values(resolvedFrom).map(dir => dir.replace(/\/node_modules\/.*$/, '')))]
for (const root of distinctRoots) console.log(`  from ${root}`)
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
