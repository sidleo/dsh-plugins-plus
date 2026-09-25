/**
 * The preset-takeover engine.
 *
 * Replacing a built-in plugin inside an agent preset still means rewriting that
 * preset's `plugins` list, because a DSH profile patch reaches the preset ROW
 * as whole-`config` replace and nothing can address a row inside it. What this
 * engine no longer does is hand-edit YAML: the composition is read from
 * `ctx.configEditor.configuration()` as parsed data (with `!!js` expressions
 * present as their inert `{ __jsExpr }` markers) and written back through
 * `ctx.configEditor.edit()`, which validates the candidate, locks the profile,
 * preserves comments and `!!js` tags, reconciles the running Loader, and
 * deletes the override row entirely once it equals the shipped layer again.
 *
 * Rows are recomposed from the SHIPPED composition on every pass, so a DSH
 * upgrade that adds or changes a preset row reaches the preset without the user
 * re-applying anything; an override's own changes to a row are kept when they
 * are not this engine's business (foreign edits survive), and a row the
 * override adds is preserved.
 *
 * @module @sidleo3/dsh-plugins-plus/takeover
 */

import { isDeepStrictEqual } from 'node:util'
import type {
  ComponentDescriptor,
} from './components.ts'
import { ownedPipelineRowIds } from './components.ts'
import type { ConfigEditorLike, PresetComposition, PresetRow } from './composition.ts'
import { hasBuiltinRow, rowsOf } from './composition.ts'

/** What one component wants for one preset. */
export interface ComponentIntent {
  readonly component: ComponentDescriptor
  /** Whether this component takes the preset over. */
  readonly active: boolean
  /**
   * Whether this engine may add or remove the component's rows here. A
   * component that has not mounted (and never did in this process) is left
   * alone, so a boot-time pass cannot strip a takeover that its activator row
   * is about to re-register.
   */
  readonly manageable: boolean
}

/** The pure input of one plan: the layers of one preset plus the intents. */
export interface PlanInput {
  readonly presetId: string
  readonly rowId: string
  /** Composition the next write starts from (profile override, else shipped). */
  readonly base: Record<string, unknown>
  /** Shipped lower-layer composition. */
  readonly inherited: Record<string, unknown>
  /** Whether the profile currently overrides this preset. */
  readonly overridden: boolean
  readonly intents: readonly ComponentIntent[]
}

/** What to do with one preset. */
export interface PresetPlan {
  readonly presetId: string
  readonly rowId: string
  /** `none`: already correct; `write`: persist `next`. */
  readonly action: 'none' | 'write'
  /** The complete config to persist; the editor removes the override when it equals the shipped layer. */
  readonly next: Record<string, unknown>
  /** Components taking this preset over. */
  readonly activeComponents: readonly string[]
  /** Non-fatal notes for the UI (a preset without the built-in row, for example). */
  readonly problems: readonly string[]
}

/** One component's ownership test over a row. */
function ownsRow(component: ComponentDescriptor, row: PresetRow): boolean {
  const id = typeof row.id === 'string' ? row.id : undefined
  if (id !== undefined && ownedPipelineRowIds(component).includes(id)) return true
  const name = typeof row.name === 'string' ? row.name : undefined
  return name !== undefined && component.legacyPipelineModules.includes(name)
}

/** Copy a row without letting a later mutation touch the layer it came from. */
function copyRow(row: PresetRow): PresetRow {
  const copy: PresetRow = { ...row }
  if ('config' in copy && typeof copy.config === 'object' && copy.config !== null) {
    copy.config = structuredClone(copy.config)
  }
  return copy
}

/**
 * Recompose a preset's rows from the shipped list, keeping whatever an
 * override changed that is not the shipped value.
 *
 * Owned rows (this bundle's pipeline rows, including an earlier release's) are
 * carried over like any other row: whether they belong in the result is decided
 * by the activation and deactivation passes, which are the only places that
 * know whether a component is mounted.
 *
 * @param shipped - rows of the shipped layer.
 * @param current - rows the profile currently has (shipped rows when not overridden).
 * @param components - every component this bundle ships, for ownership tests.
 * @returns the row list the engine edits on top of.
 */
export function mergeRows(
  shipped: readonly PresetRow[],
  current: readonly PresetRow[],
  components: readonly ComponentDescriptor[],
): PresetRow[] {
  const currentById = new Map<string, PresetRow>()
  for (const row of current) {
    if (typeof row.id === 'string' && !currentById.has(row.id)) currentById.set(row.id, row)
  }
  const shippedIds = new Set(shipped.map(row => (typeof row.id === 'string' ? row.id : undefined)))

  const out: PresetRow[] = shipped.map(row => {
    const existing = typeof row.id === 'string' ? currentById.get(row.id) : undefined
    if (existing === undefined) return copyRow(row)
    // A row the override changed (ours or a foreign plugin's) wins over the
    // shipped value; an identical row is taken from the shipped layer so an
    // upstream change to it reaches the preset.
    return isDeepStrictEqual(existing, row) ? copyRow(row) : copyRow(existing)
  })

  for (const row of current) {
    if (typeof row.id === 'string') {
      if (shippedIds.has(row.id)) continue
      out.push(copyRow(row))
      continue
    }
    // An id-less row can only be kept when the shipped layer does not declare it.
    if (shipped.some(candidate => isDeepStrictEqual(candidate, row))) continue
    out.push(copyRow(row))
  }

  return out
}

/** Restore a row's `disabled` value to what the shipped layer declares. */
function restoreDisabled(row: PresetRow, shipped: PresetRow | undefined): PresetRow {
  const next = copyRow(row)
  if (shipped === undefined || !('disabled' in shipped)) {
    delete next.disabled
    return next
  }
  next.disabled = structuredClone(shipped.disabled)
  return next
}

/**
 * Compute the next composition of one preset. Pure: the caller supplies the
 * layers, so the same function runs inside the config editor's `change`
 * callback where the current values are re-read for the race.
 * @param input - layers plus intents.
 * @returns the plan, including whether anything has to be written.
 */
export function planPreset(input: PlanInput): PresetPlan {
  const problems: string[] = []
  const shippedRows = rowsOf(input.inherited)
  const shipped = shippedRows.length > 0 ? shippedRows : rowsOf(input.base)
  const activeComponents: string[] = []

  let rows = mergeRows(shipped, rowsOf(input.base), input.intents.map(intent => intent.component))

  // Activation first, so a component that stays active keeps its row in place.
  for (const intent of input.intents) {
    const { component, active, manageable } = intent
    if (!manageable) continue
    const applicable = shipped.some(row => row.id === component.builtinRowId)
      || rowsOf(input.base).some(row => row.id === component.builtinRowId)
    if (!active) continue
    if (!applicable) {
      problems.push(`${component.id}: 预设不含 ${component.builtinRowId} 行，无需接管`)
      continue
    }
    activeComponents.push(component.id)
    rows = rows.map(row =>
      row.id === component.builtinRowId ? { ...copyRow(row), disabled: true } : row,
    )
    // Earlier releases wrote their own pipeline row; fold it into this one.
    rows = rows.filter(
      row => !(component.legacyPipelineRowIds.includes(row.id ?? '') || ownsLegacyModule(component, row)),
    )
    const existing = rows.find(row => row.id === component.pipelineRowId)
    if (existing === undefined) {
      rows.push({ id: component.pipelineRowId, name: component.pipelineModule })
    } else if (existing.name !== component.pipelineModule) {
      rows = rows.map(row => (row.id === component.pipelineRowId ? { ...row, name: component.pipelineModule } : row))
    }
  }

  for (const intent of input.intents) {
    const { component, manageable } = intent
    if (!manageable) continue
    if (activeComponents.includes(component.id)) continue
    const shippedBuiltin = shipped.find(row => row.id === component.builtinRowId)
    // Undo the takeover when this bundle owns a row here, and also when the
    // built-in row is still gated while no pipeline row stands beside it
    // (a hand-edited or half-removed composition), which would otherwise leave
    // the preset with no instruction/skill source at all.
    const ownsPipeline = rows.some(row => ownsRow(component, row))
    const builtinStillGated = rows.some(
      row => row.id === component.builtinRowId && !isDeepStrictEqual(row.disabled, shippedBuiltin?.disabled),
    )
    if (!ownsPipeline && !builtinStillGated) continue
    rows = rows.filter(row => !ownsRow(component, row))
    rows = rows.map(row => (row.id === component.builtinRowId ? restoreDisabled(row, shippedBuiltin) : row))
  }

  const next: Record<string, unknown> = { ...input.base, plugins: rows }
  const equalsShipped = isDeepStrictEqual(next, input.inherited)
  // When the composition is back to the shipped layer the editor deletes the
  // override row itself: persist anyway when one exists, otherwise do nothing.
  if (!input.overridden && equalsShipped) {
    return { presetId: input.presetId, rowId: input.rowId, action: 'none', next, activeComponents, problems }
  }
  if (input.overridden && isDeepStrictEqual(next, input.base)) {
    return { presetId: input.presetId, rowId: input.rowId, action: 'none', next, activeComponents, problems }
  }
  return { presetId: input.presetId, rowId: input.rowId, action: 'write', next, activeComponents, problems }
}

/** Whether a row is an earlier release's pipeline row of this component. */
function ownsLegacyModule(component: ComponentDescriptor, row: PresetRow): boolean {
  return typeof row.name === 'string' && component.legacyPipelineModules.includes(row.name)
}

/** One preset's outcome after an engine pass. */
export interface ReconcileEntry extends PresetPlan {
  /** Present when the write failed. */
  readonly error?: string
}

/** The outcome of one engine pass. */
export interface ReconcileReport {
  /** ISO timestamp of the pass. */
  readonly at: string
  /** Why the pass ran. */
  readonly reason: string
  /** Components known to be mounted when the pass ran. */
  readonly mounted: readonly string[]
  /** One record per preset. */
  readonly entries: readonly ReconcileEntry[]
  /** Writes that reached the profile patch. */
  readonly written: number
  /** Non-fatal notes collected over all presets. */
  readonly problems: readonly string[]
  /** Presets whose write failed. */
  readonly failures: readonly { readonly presetId: string; readonly error: string }[]
}

/** The engine's view of the world, injected so the planner stays testable. */
export interface EngineDeps {
  readonly editor: ConfigEditorLike
  readonly components: readonly ComponentDescriptor[]
  /** Components currently mounted (their activator rows loaded). */
  readonly mounted: () => ReadonlySet<string>
  /** Whether a component has been mounted at least once in this process. */
  readonly everMounted: () => ReadonlySet<string>
  /** Effective preset selection per component. */
  readonly selection: (componentId: string) => { mode: 'list' | 'all' | 'none'; presets: readonly string[] }
  readonly log?: (message: string) => void
}

/**
 * Run one engine pass: read every preset, compute the composition it should
 * have, and persist the presets whose composition differs.
 * @param deps - services and configuration readers.
 * @param compositions - presets to consider, usually from {@link readCompositions}.
 * @param reason - why the pass runs, recorded in the report.
 * @returns the report; failures are collected rather than thrown.
 */
export async function reconcile(
  deps: EngineDeps,
  compositions: readonly PresetComposition[],
  reason: string,
): Promise<ReconcileReport> {
  const mounted = deps.mounted()
  const everMounted = deps.everMounted()
  const entries: ReconcileEntry[] = []
  const problems: string[] = []
  const failures: { presetId: string; error: string }[] = []
  let written = 0

  for (const composition of compositions) {
    if (composition.broken !== undefined || composition.rows.length === 0) continue
    const intents: ComponentIntent[] = deps.components.map(component => {
      const selection = deps.selection(component.id)
      const wanted =
        selection.mode === 'all'
        || (selection.mode === 'list' && selection.presets.includes(composition.presetId))
      const isMounted = mounted.has(component.id)
      return {
        component,
        active: wanted && isMounted,
        manageable: isMounted || everMounted.has(component.id),
      }
    })

    if (!intents.some(intent => intent.manageable)) {
      entries.push({
        presetId: composition.presetId,
        rowId: composition.rowId,
        action: 'none',
        next: composition.base,
        activeComponents: [],
        problems: [],
      })
      continue
    }

    const plan = planPreset({
      presetId: composition.presetId,
      rowId: composition.rowId,
      base: composition.base,
      inherited: composition.inherited,
      overridden: composition.overridden,
      intents,
    })
    problems.push(...plan.problems.map(problem => `${composition.presetId} · ${problem}`))

    if (plan.action === 'none') {
      entries.push(plan)
      continue
    }

    try {
      const entry = composition.entry as Parameters<ConfigEditorLike['edit']>[0]
      await deps.editor.edit(entry, (current, inherited) => {
        // Recompute against the values the editor just read: the plan the UI
        // saw may be stale by the time the profile lock is held.
        const replanned = planPreset({
          presetId: composition.presetId,
          rowId: composition.rowId,
          base: current ?? {},
          inherited: inherited ?? {},
          overridden: Object.keys(current ?? {}).length > 0,
          intents,
        })
        return replanned.next
      })
      written += 1
      entries.push({ ...plan, activeComponents: plan.activeComponents })
      deps.log?.(
        `[dsh-plugins-plus] ${composition.presetId}: ${plan.activeComponents.length > 0 ? `接管 ${plan.activeComponents.join(', ')}` : '恢复内置组合'}`,
      )
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      failures.push({ presetId: composition.presetId, error: message })
      entries.push({ ...plan, error: message })
      deps.log?.(`[dsh-plugins-plus] ${composition.presetId}: 写入失败 — ${message}`)
    }
  }

  return {
    at: new Date().toISOString(),
    reason,
    mounted: [...mounted],
    entries,
    written,
    problems,
    failures,
  }
}
