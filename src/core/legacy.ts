/**
 * One-shot migration from the two standalone plugins.
 *
 * Two kinds of state move into the shared configuration:
 *  - the JSON settings files `~/.dsh/dsh-instruction-scan.json` and
 *    `~/.dsh/dsh-skill-filesystem-plus.json` (the old hosts persisted there),
 *    imported once;
 *  - the preset takeovers the old wizards had already written, which are
 *    adopted as this bundle's per-component preset selection so the user does
 *    not have to re-tick every preset.
 *
 * The import never overwrites a value the profile already declares, seeds only
 * the fields that are still missing, and is recorded by a timestamp in this
 * bundle's own configuration — **it never renames or deletes the legacy
 * files**. Those files live in the shared DSH home, so touching them would
 * silently reset the settings of any other profile that still runs the old
 * plugins.
 *
 * @module @sidleo3/dsh-plugins-plus/legacy
 */

import { readFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import type { ComponentDescriptor } from './components.ts'
import type { PresetComposition, PresetRow } from './composition.ts'

/** Legacy settings files, newest name first, per component id. */
const LEGACY_CONFIG_FILES: Record<string, readonly string[]> = {
  'agent-instructions-plus': ['dsh-instruction-scan.json'],
  'skill-filesystem-plus': ['dsh-skill-filesystem-plus.json', 'dsh-skill-scan.json'],
}

/** The old packages' fields that map onto this bundle's component sections. */
const LEGACY_FIELDS = [
  'scanCwd',
  'scanProject',
  'scanParents',
  'scanGlobal',
  'instructionFileCandidates',
  'localInstructionFileCandidates',
  'projectRootMarkers',
  'dshHome',
  'maxBytes',
  'maxSourceBytes',
  'parentDirs',
] as const

/** @returns the DSH home directory the old hosts wrote into. */
function dshHome(): string {
  const configured = process.env.DSH_HOME?.trim()
  if (configured !== undefined && configured.length > 0) return configured
  return join(homedir(), '.dsh')
}

/** One component's legacy JSON settings, when a legacy file exists. */
export interface LegacyConfigFile {
  readonly componentId: string
  readonly path: string
  readonly values: Record<string, unknown>
}

/**
 * Read every legacy settings file that still exists.
 * @returns one record per file that parsed, in component order.
 */
export function readLegacyConfigs(): LegacyConfigFile[] {
  const out: LegacyConfigFile[] = []
  for (const [componentId, names] of Object.entries(LEGACY_CONFIG_FILES)) {
    for (const name of names) {
      const path = join(dshHome(), name)
      let parsed: unknown
      try {
        parsed = JSON.parse(readFileSync(path, 'utf8'))
      } catch {
        continue
      }
      if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) continue
      const source = parsed as Record<string, unknown>
      const values: Record<string, unknown> = {}
      for (const field of LEGACY_FIELDS) {
        if (field in source) values[field] = source[field]
      }
      out.push({ componentId, path, values })
      break
    }
  }
  return out
}

/** Rename a migrated file out of the way so it is imported exactly once. */
/** Legacy settings files that still exist, for a one-line cleanup hint. */
export function listLegacyFiles(): string[] {
  return readLegacyConfigs().map(file => file.path)
}

/**
 * Presets the old wizards had already taken over, per component, read off the
 * legacy pipeline rows that are still present in a preset's composition.
 * @param compositions - presets read from the config editor.
 * @param components - components this bundle ships.
 * @returns component id → preset ids that carry a legacy takeover.
 */
export function adoptLegacyTakeovers(
  compositions: readonly PresetComposition[],
  components: readonly ComponentDescriptor[],
): Record<string, string[]> {
  const adopted: Record<string, string[]> = {}
  for (const component of components) {
    const presetIds = compositions
      .filter(composition => composition.rows.some(row => isLegacyRow(component, row)))
      .map(composition => composition.presetId)
    if (presetIds.length > 0) adopted[component.id] = presetIds
  }
  return adopted
}

/** Whether one row is an earlier release's pipeline row of this component. */
function isLegacyRow(component: ComponentDescriptor, row: PresetRow): boolean {
  const id = typeof row.id === 'string' ? row.id : undefined
  if (id !== undefined && component.legacyPipelineRowIds.includes(id)) return true
  const name = typeof row.name === 'string' ? row.name : undefined
  return name !== undefined && component.legacyPipelineModules.includes(name)
}

/** The configuration seed one migration pass produces. */
export interface MigrationSeed {
  /**
   * Component subtree to write: only the fields the profile does not declare
   * yet, so the Loader keeps applying schema defaults to everything else.
   */
  readonly components?: Record<string, Record<string, unknown>>
  /** Components whose preset selection is adopted from a legacy takeover. */
  readonly adoptedPresets?: Record<string, string[]>
  /** Legacy settings files the import read; the user may delete them by hand. */
  readonly readFiles?: readonly string[]
  /** Human-readable summary lines for the log. */
  readonly notes: readonly string[]
}

/**
 * Build the seed for one migration pass.
 *
 * @param options.currentOverride - the core row's profile override, the record of what the user already configured.
 * @param options.compositions - presets read from the config editor.
 * @param options.components - components this bundle ships.
 * @returns the seed; empty when there is nothing to migrate.
 */
export function buildMigrationSeed(options: {
  readonly currentOverride: Record<string, unknown>
  readonly compositions: readonly PresetComposition[]
  readonly components: readonly ComponentDescriptor[]
}): MigrationSeed {
  const notes: string[] = []
  // The timestamp double as the "already imported" record, so a second pass
  // cannot resurrect a value the user cleared in the meantime.
  if (typeof options.currentOverride.legacyImport === 'string' && options.currentOverride.legacyImport.length > 0) {
    return { notes }
  }
  const currentComponents = (options.currentOverride.components ?? {}) as Record<string, Record<string, unknown>>
  const files = readLegacyConfigs()
  const components: Record<string, Record<string, unknown>> = {}

  for (const file of files) {
    const existing = currentComponents[file.componentId] ?? {}
    const missing: Record<string, unknown> = {}
    for (const [key, value] of Object.entries(file.values)) {
      if (!(key in existing) && !(key in (components[file.componentId] ?? {}))) missing[key] = value
    }
    if (Object.keys(missing).length === 0) {
      notes.push(`${file.componentId}: 旧配置 ${file.path} 的字段已全部存在，仅记录导入时间`)
      continue
    }
    components[file.componentId] = { ...(components[file.componentId] ?? {}), ...missing }
    notes.push(`${file.componentId}: 从 ${file.path} 导入 ${Object.keys(missing).join(', ')}`)
  }

  // Preset selection: adopt a legacy takeover only when the user has not
  // chosen a selection for that component yet.
  const adopted = adoptLegacyTakeovers(options.compositions, options.components)
  const adoptedPresets: Record<string, string[]> = {}
  const hasGlobalSelection = 'presets' in options.currentOverride || 'presetsMode' in options.currentOverride
  for (const [componentId, presetIds] of Object.entries(adopted)) {
    const existing = currentComponents[componentId] ?? {}
    if ('presets' in existing || 'presetsMode' in existing || 'useGlobalPresets' in existing) continue
    if (hasGlobalSelection) continue
    adoptedPresets[componentId] = presetIds
    components[componentId] = {
      ...(components[componentId] ?? {}),
      useGlobalPresets: false,
      presetsMode: 'list',
      presets: presetIds,
    }
    notes.push(`${componentId}: 沿用旧的接管选择 ${presetIds.join('、')}`)
  }

  return {
    components: Object.keys(components).length > 0 ? components : undefined,
    adoptedPresets: Object.keys(adoptedPresets).length > 0 ? adoptedPresets : undefined,
    readFiles: files.map(file => file.path),
    notes,
  }
}
