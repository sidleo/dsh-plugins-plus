/**
 * dsh-plugins-plus core row — the bundle's only always-on plugin.
 *
 * Responsibilities:
 *  - declare the one `Config` schema every component reads (DSH derives the
 *    Settings form from it and persists edits into the profile patch through
 *    the config editor, so this bundle keeps no settings file of its own);
 *  - provide the runtime service the activator rows register into and the
 *    session-plane rows read their settings from;
 *  - run the preset-takeover engine (mount, configuration change, component
 *    mount/unmount, and on demand);
 *  - import the two standalone plugins' JSON settings and adopt the preset
 *    takeovers their wizards had written, exactly once;
 *  - answer the browser's read-only status and scan-root questions.
 *
 * @module @sidleo3/dsh-plugins-plus
 */

import type { Context } from '@deepseek-ai/cordis'
import { COMPONENTS, componentById } from './core/components.ts'
import type { ConfigEditorLike, PresetComposition } from './core/composition.ts'
import { readCompositions } from './core/composition.ts'
import { Config, readSnapshot, type PluginsPlusConfig } from './core/config.ts'
import { outsideHmrTransaction } from './core/hmr.ts'
import { buildMigrationSeed } from './core/legacy.ts'
import { PluginsPlusService } from './core/registry.ts'
import { registerRoutes } from './core/rpc.ts'
import { reconcile, type EngineDeps, type ReconcileReport } from './core/takeover.ts'
import { computeRoots, resolveUserHome, type ProviderFs } from './components/skill-filesystem/provider.ts'

export { Config }
export type { PluginsPlusConfig } from './core/config.ts'
export {
  CORE_DEFAULTS,
  COMPONENT_DEFAULTS,
  effectivePresetSelection,
  normalizeComponents,
  normalizeParentDirs,
  readSnapshot,
} from './core/config.ts'
export { PluginsPlusService, SERVICE_NAME } from './core/registry.ts'
export { COMPONENTS, componentById, ownedPipelineRowIds } from './core/components.ts'
export type { ComponentDescriptor } from './core/components.ts'
export { mergeRows, planPreset, reconcile } from './core/takeover.ts'
export type { ComponentIntent, PlanInput, PresetPlan, ReconcileReport } from './core/takeover.ts'
export { hasBuiltinRow, readCompositions, rowsOf, PRESET_MODULE } from './core/composition.ts'
export type { ConfigEditorLike, PresetComposition, PresetRow } from './core/composition.ts'
export { adoptLegacyTakeovers, buildMigrationSeed, listLegacyFiles, readLegacyConfigs } from './core/legacy.ts'

/** Bundle package name, as `package.json` publishes it. */
export const PACKAGE_NAME = '@sidleo3/dsh-plugins-plus'
/** Row id of this core plugin inside the bundle patch. */
export const CORE_ROW_ID = 'dsh-plugins-plus'

export const name = 'dsh-plugins-plus'

/** How long the engine waits for mount-time churn to settle before a pass. */
const SETTLE_MS = 200
/** How long the engine waits after a configuration write before a pass. */
const CONFIG_DEBOUNCE_MS = 250
/** Backoff for a pass a busy host refused, in milliseconds. */
const RETRY_DELAYS_MS = [400, 900, 1800, 3600, 7200]

/** Migration outcome, reported through the status route. */
interface MigrationReport {
  readonly at: string
  readonly notes: readonly string[]
  readonly error?: string
}

/** The state the RPC surface reports. */
interface BundleState {
  lastReport?: ReconcileReport
  migration?: MigrationReport
  lastError?: string
}

/**
 * Register the core row.
 * @param ctx - the row's context.
 * @param config - the row's resolved configuration (volatile references intact).
 */
export function apply(ctx: Context, config: PluginsPlusConfig): void {
  const service = new PluginsPlusService(ctx, config)
  const state: BundleState = {}

  // We ship our own configuration pages, so the generic schema-derived form
  // must not also claim this entry. The policy is keyed by the fiber of the ROW
  // itself: the settings service reads `presentations.get(entry.fiber)`, so
  // passing the inject child's fiber would register a policy nothing reads.
  ctx.inject(['settings'], sctx => {
    const settings = sctx.get('settings') as
      | { configure?: (presentation: { auto: boolean }, owner?: unknown) => unknown }
      | undefined
    try {
      settings?.configure?.({ auto: false }, ctx.fiber)
    } catch (error) {
      ctx.logger?.warn?.(`[dsh-plugins-plus] settings.configure failed: ${String(error)}`)
    }
  })

  ctx.inject(['configEditor'], ectx => {
    const editor = ectx.get('configEditor') as ConfigEditorLike | undefined
    if (editor === undefined) return
    startEngine(ectx, editor, service, state)
  })

  ctx.inject(['webServer'], wctx => {
    const registered = registerRoutes(wctx, {
      status: () => statusOf(wctx, service, state),
      roots: cwd => scanRoots(wctx, service, cwd),
      reconcile: async () => {
        const report = await service.requestReconcileNow('manual')
        return { ok: true, report }
      },
    })
    if (!registered) {
      ctx.logger?.warn?.('[dsh-plugins-plus] webServer unavailable — the settings page cannot show scan previews')
    }
  })

  // A volatile commit reaches the owning fiber without a remount: this is how
  // a Settings edit becomes a takeover pass.
  const events = ctx as unknown as {
    on(name: string, listener: (...args: unknown[]) => void): unknown
  }
  events.on('loader/volatile-update', () => {
    service.announce('config')
  })

  // The settings service also publishes a revision per namespace whenever a
  // form write lands. Listening to both means a write is noticed whichever
  // layer reports it first; the engine debounces the duplicates into one pass.
  events.on('settings/document-updated', (...args: unknown[]) => {
    if (args[0] !== CORE_ROW_ID) return
    service.announce('settings-write')
  })
}

/**
 * Start the takeover engine once the config editor is available.
 * @param ctx - context carrying `configEditor`.
 * @param editor - the profile's config editor.
 * @param service - the bundle service.
 * @param state - mutable state reported through the status route.
 */
function startEngine(
  ctx: Context,
  editor: ConfigEditorLike,
  service: PluginsPlusService,
  state: BundleState,
): void {
  let timer: ReturnType<typeof setTimeout> | undefined
  let running: Promise<ReconcileReport | undefined> | undefined
  let queued = false
  let migrated = false
  let retries = 0

  const log = (message: string): void => {
    console.log(message)
  }

  const deps: EngineDeps = {
    editor,
    components: COMPONENTS,
    mounted: () => service.mountedComponents(),
    everMounted: () => service.everMountedComponents(),
    selection: componentId => {
      const selection = service.selection(componentId)
      return { mode: selection.mode, presets: selection.presets }
    },
    log,
  }

  async function performPass(reason: string): Promise<ReconcileReport | undefined> {
    try {
      let compositions = await readCompositions(ctx)
      if (!migrated) {
        migrated = true
        const outcome = await migrateOnce(editor, compositions, service.snapshot().legacyImport)
        if (outcome !== undefined) {
          state.migration = outcome
          if (outcome.notes.length > 0) for (const note of outcome.notes) log(`[dsh-plugins-plus] 迁移：${note}`)
          if (outcome.error !== undefined) log(`[dsh-plugins-plus] 迁移失败：${outcome.error}`)
          // The migration wrote the core row's own config; re-read before planning.
          compositions = await readCompositions(ctx)
        }
      }
      const report = await outsideHmrTransaction(ctx, () => reconcile(deps, compositions, reason))
      state.lastReport = report
      state.lastError = undefined
      // A Settings write reconciles the profile under DSH's HMR transaction, so
      // a pass that starts too early is refused with "HMR transactions cannot
      // be nested". The pass is idempotent, so retry a few times with backoff
      // until the host is idle enough to accept the write.
      if (report.failures.length > 0 && retries < RETRY_DELAYS_MS.length) {
        const delay = RETRY_DELAYS_MS[retries]
        retries += 1
        log(`[dsh-plugins-plus] ${report.failures.length} 个预设写入失败，${delay}ms 后重试（第 ${retries} 次）`)
        schedule('retry', delay)
      } else {
        retries = 0
      }
      return report
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      state.lastError = message
      log(`[dsh-plugins-plus] 接管引擎失败：${message}`)
      return undefined
    }
  }

  async function runPass(reason: string): Promise<ReconcileReport | undefined> {
    if (running !== undefined) {
      queued = true
      return running
    }
    running = performPass(reason)
    try {
      return await running
    } finally {
      running = undefined
      if (queued) {
        queued = false
        schedule('queued')
      }
    }
  }

  function schedule(reason: string, delay = CONFIG_DEBOUNCE_MS): void {
    if (timer !== undefined) clearTimeout(timer)
    timer = setTimeout(() => {
      timer = undefined
      void runPass(reason)
    }, delay)
    // Never hold the process open for a debounce.
    ;(timer as unknown as { unref?: () => void }).unref?.()
  }

  service.attachEngine({
    trigger: reason => schedule(reason),
    runNow: reason => runPass(reason),
  })

  ctx.effect(() => () => {
    if (timer !== undefined) clearTimeout(timer)
    return undefined
  })

  // First pass after the activator rows have had their chance to register.
  schedule('mount', SETTLE_MS)
}

/**
 * Import the standalone plugins' settings and adopt their takeover selection.
 * Runs at most once per profile: the import records itself with a timestamp in
 * this bundle's configuration, and the legacy files are left untouched (they
 * live in the shared DSH home, where another profile may still use them).
 * @param editor - the profile's config editor.
 * @param compositions - presets read before the first pass.
 * @param alreadyImported - the recorded import timestamp, empty when none.
 * @returns the migration report, or undefined when there was nothing to do.
 */
async function migrateOnce(
  editor: ConfigEditorLike,
  compositions: readonly PresetComposition[],
  alreadyImported: string,
): Promise<MigrationReport | undefined> {
  if (alreadyImported.length > 0) return undefined
  const coreEntry = editor.entries().find(entry => entry.options.name === PACKAGE_NAME)
  if (coreEntry === undefined) return undefined
  const configuration = editor.configuration().find(item => item.entry === coreEntry)
  const currentOverride = configuration?.override ?? {}
  const seed = buildMigrationSeed({ currentOverride, compositions, components: COMPONENTS })
  if ((seed.readFiles ?? []).length === 0 && seed.components === undefined) return undefined

  const notes = [...seed.notes]
  const stamp = new Date().toISOString()
  try {
    const entry = coreEntry as Parameters<ConfigEditorLike['edit']>[0]
    await editor.edit(entry, current => ({
      ...current,
      legacyImport: stamp,
      ...(seed.components === undefined
        ? {}
        : { components: { ...((current.components as Record<string, unknown>) ?? {}), ...seed.components } }),
    }))
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    return { at: stamp, notes, error: message }
  }

  for (const path of seed.readFiles ?? []) {
    notes.push(`已读取 ${path}（原文件保留，确认无用后可自行删除）`)
  }
  return { at: stamp, notes }
}

/** Compose the status payload the configuration page renders. */
async function statusOf(ctx: Context, service: PluginsPlusService, state: BundleState): Promise<unknown> {
  const compositions = await readCompositions(ctx)
  const snapshot = service.snapshot()
  const components = COMPONENTS.map(component => {
    const selection = service.selection(component.id)
    return {
      id: component.id,
      builtinRowId: component.builtinRowId,
      pipelineRowId: component.pipelineRowId,
      mounted: service.mountedComponents().has(component.id),
      everMounted: service.everMountedComponents().has(component.id),
      selection: { inherited: selection.inherited, mode: selection.mode, presets: selection.presets },
    }
  })

  const presets = compositions.map(composition => {
    const rows = composition.rows.map(row => ({
      id: typeof row.id === 'string' ? row.id : undefined,
      name: typeof row.name === 'string' ? row.name : undefined,
      disabled: row.disabled === true,
    }))
    const perComponent: Record<string, { applicable: boolean; pipeline: boolean; builtinDisabled: boolean }> = {}
    for (const component of COMPONENTS) {
      const shippedRows = composition.inheritedRows.length > 0 ? composition.inheritedRows : composition.rows
      perComponent[component.id] = {
        applicable: shippedRows.some(row => row.id === component.builtinRowId),
        pipeline: composition.rows.some(
          row => row.id === component.pipelineRowId || component.legacyPipelineModules.includes(String(row.name)),
        ),
        builtinDisabled: composition.rows.some(row => row.id === component.builtinRowId && row.disabled === true),
      }
    }
    return {
      id: composition.presetId,
      rowId: composition.rowId,
      name: composition.displayName,
      description: composition.description,
      isDefault: composition.isDefault,
      broken: composition.broken,
      overridden: composition.overridden,
      addressable: composition.rows.length > 0 || Object.keys(composition.inherited).length > 0,
      components: perComponent,
      rowCount: rows.length,
    }
  })

  return {
    ok: true,
    package: PACKAGE_NAME,
    coreRowId: CORE_ROW_ID,
    api: '/api/dsh-plugins-plus',
    config: snapshot,
    components,
    presets,
    report: state.lastReport ?? null,
    migration: state.migration ?? null,
    error: state.lastError ?? null,
  }
}

/** Answer the scan-root preview for one working directory. */
async function scanRoots(ctx: Context, service: PluginsPlusService, cwd: string | undefined): Promise<unknown> {
  const fs = ctx.get('fs') as ProviderFs | undefined
  const config = service.skillConfig()
  const target = cwd ?? fallbackCwd(ctx)
  const roots = await computeRoots(config, target, {
    fs,
    home: () => resolveUserHome(ctx as unknown as { get(name: string): unknown }),
  })
  return { ok: true, cwd: target, config, roots }
}

/** Best-effort working directory when the client names none. */
function fallbackCwd(ctx: Context): string {
  try {
    const registry = ctx.get('workspaceRegistry') as { list?: () => { path?: string }[] } | undefined
    const workspaces = registry?.list?.()
    const first = Array.isArray(workspaces) ? workspaces[0] : undefined
    if (first !== undefined && typeof first.path === 'string' && first.path.length > 0) return first.path
  } catch {
    // fall through
  }
  return process.cwd()
}
