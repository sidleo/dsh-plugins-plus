/**
 * Reading agent-preset compositions through DSH's own services.
 *
 * Nothing here parses YAML or edits files: the config editor hands back the
 * inherited (shipped) and override (profile patch) values of every addressable
 * Loader row, with `!!js` expressions already represented by their inert
 * `{ __jsExpr }` marker objects, and the preset registry reports the roster.
 * The takeover engine only computes a new `config` object and hands it back.
 *
 * @module @sidleo3/dsh-plugins-plus/composition
 */

import type { Context } from '@deepseek-ai/cordis'
import type { Entry } from '@deepseek-ai/cordis-plugin-loader'

/**
 * One roster entry as the composition inventory reports it.
 *
 * Typed structurally rather than imported: the registry's public entry point
 * does not re-export its inventory types, and this package only reads four
 * fields off them.
 */
export interface AgentPresetInventoryEntry {
  /** Stable preset id. */
  readonly id: string
  /** Display name the preset published. */
  readonly name?: string
  /** Whether a session naming no preset composes this one. */
  readonly isDefault: boolean
  /** Why the preset's rows cannot be read; absent when they can. */
  readonly broken?: string
  /** Composition rows, used only for size checks here. */
  readonly rows: readonly unknown[]
}

/** One child plugin row inside a preset composition, as the Loader parsed it. */
export interface PresetRow {
  id?: string
  name?: string
  disabled?: unknown
  config?: unknown
  [key: string]: unknown
}

/** A preset declaration row as the config editor sees it. */
export interface ConfigEditorEntry {
  options: { id: string; name?: string; config?: Record<string, unknown> }
  fiber?: unknown
}

/** The subset of `ctx.configEditor` this package uses. */
export interface ConfigEditorLike {
  entries(): readonly ConfigEditorEntry[]
  configuration(): readonly {
    entry: ConfigEditorEntry
    inherited: Record<string, unknown>
    override: Record<string, unknown>
  }[]
  edit(
    entry: Entry,
    change: (current: Record<string, unknown>, inherited: Record<string, unknown>) => Record<string, unknown>,
  ): Promise<void>
}

/** The subset of `ctx.agentPresets` this package uses. */
export interface AgentPresetsLike {
  compositionInventory(): Promise<readonly AgentPresetInventoryEntry[]>
  list(): Promise<readonly { id: string; name?: string; description?: string; order?: number; broken?: string }[]>
}

/** Module name every preset declaration row carries. */
export const PRESET_MODULE = '@deepseek-ai/dsh-agent-preset'

/** One preset, its live composition, and the layers behind it. */
export interface PresetComposition {
  /** `config.id` — the identity sessions store and the roster reports. */
  readonly presetId: string
  /** Loader row id of the declaration (`preset-<id>` for shipped presets). */
  readonly rowId: string
  /** Display name the declaration published. */
  readonly displayName?: string
  readonly description?: string
  /** Whether a session naming no preset composes this one. */
  readonly isDefault: boolean
  /** Why the preset's rows cannot be read, when the registry says so. */
  readonly broken?: string
  /** The shipped lower-layer config, or `{}` when the layer declares none. */
  readonly inherited: Record<string, unknown>
  /** The profile override, or `{}` when the profile declares none. */
  readonly override: Record<string, unknown>
  /** Whether the profile currently overrides this preset. */
  readonly overridden: boolean
  /** The composition the next edit starts from: the override, else the shipped value. */
  readonly base: Record<string, unknown>
  /** Rows of {@link base}. */
  readonly rows: readonly PresetRow[]
  /** Rows of the shipped layer, used to restore a row's own `disabled` value. */
  readonly inheritedRows: readonly PresetRow[]
  /** The Loader entry a write targets. */
  readonly entry: ConfigEditorEntry
}

/** @returns the rows array of a preset config, or an empty list. */
export function rowsOf(config: Record<string, unknown> | undefined): PresetRow[] {
  const rows = config?.plugins
  if (!Array.isArray(rows)) return []
  return rows.filter((row): row is PresetRow => typeof row === 'object' && row !== null && !Array.isArray(row))
}

/** @returns the declared preset id of one config object. */
function declaredPresetId(config: Record<string, unknown> | undefined): string | undefined {
  const id = config?.id
  return typeof id === 'string' && id.trim().length > 0 ? id.trim() : undefined
}

/**
 * Read every agent preset declared in this profile together with the layers
 * behind it. Presets the config editor cannot address (nested includes) are
 * reported without an entry so the UI can name them instead of dropping them.
 * @param ctx - plugin context providing `configEditor` and `agentPresets`.
 * @returns one record per declared preset, in roster order when the registry answers.
 */
export async function readCompositions(ctx: Context): Promise<PresetComposition[]> {
  const editor = ctx.get('configEditor') as ConfigEditorLike | undefined
  const registry = ctx.get('agentPresets') as AgentPresetsLike | undefined
  if (editor === undefined) return []

  const roster = await rosterOf(registry)
  const rosterById = new Map(roster.map(entry => [entry.id, entry]))
  const out: PresetComposition[] = []

  for (const item of editor.configuration()) {
    const entry = item.entry
    if (entry.options.name !== PRESET_MODULE) continue
    const presetId = declaredPresetId(item.override) ?? declaredPresetId(item.inherited)
    if (presetId === undefined) continue
    const meta = rosterById.get(presetId)
    const inherited = item.inherited ?? {}
    const override = item.override ?? {}
    const overridden = Object.keys(override).length > 0
    const base = overridden ? override : inherited
    out.push({
      presetId,
      rowId: entry.options.id,
      displayName: meta?.name,
      description: meta?.description,
      isDefault: meta?.isDefault === true,
      broken: meta?.broken,
      inherited,
      override,
      overridden,
      base,
      rows: rowsOf(base),
      inheritedRows: rowsOf(inherited),
      entry,
    })
    rosterById.delete(presetId)
  }

  // Presets the config editor cannot address stay visible to the UI.
  for (const meta of rosterById.values()) {
    out.push({
      presetId: meta.id,
      rowId: `preset-${meta.id}`,
      displayName: meta.name,
      description: meta.description,
      isDefault: meta.isDefault,
      broken: meta.broken,
      inherited: {},
      override: {},
      overridden: false,
      base: {},
      rows: [],
      inheritedRows: [],
      entry: { options: { id: `preset-${meta.id}`, name: PRESET_MODULE } },
    })
  }

  return out
}

interface RosterEntry {
  id: string
  name?: string
  description?: string
  isDefault: boolean
  broken?: string
}

/** Read the roster defensively: a broken registry must not break the UI. */
async function rosterOf(registry: AgentPresetsLike | undefined): Promise<RosterEntry[]> {
  if (registry === undefined) return []
  try {
    const inventory = await registry.compositionInventory()
    return inventory.map(item => ({
      id: item.id,
      name: item.name,
      isDefault: item.isDefault === true,
      broken: item.broken,
    }))
  } catch {
    // Fall through to the lighter roster call.
  }
  try {
    const presets = await registry.list()
    return presets.map(item => ({ id: item.id, name: item.name, description: item.description, isDefault: false, broken: item.broken }))
  } catch {
    return []
  }
}

/** Whether one component's built-in row exists in a composition. */
export function hasBuiltinRow(composition: PresetComposition, builtinRowId: string): boolean {
  const rows = composition.inheritedRows.length > 0 ? composition.inheritedRows : composition.rows
  return rows.some(row => row.id === builtinRowId)
}
