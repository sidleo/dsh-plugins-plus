/**
 * dsh-plugins-plus configuration — the one schema every component reads.
 *
 * DSH derives plugin configuration forms from a Loader row's `Config` schema:
 * only fields marked `.volatile()` are editable live (they are committed into
 * the running fiber without a remount and announced through
 * `loader/volatile-update`), and every value the user edits lands in the
 * profile patch through the config editor — this package keeps no JSON file of
 * its own.
 *
 * Volatile placement is constrained by schemastery: a volatile field must sit
 * at a fixed object path and must NOT be nested inside another volatile field
 * ("volatile fields require a fixed object path without an enclosing volatile
 * field"). The schema therefore marks exactly three nodes volatile — the two
 * global preset fields and the whole `components` subtree — and leaves every
 * field beneath them plain.
 *
 * @module @sidleo3/dsh-plugins-plus/config
 */

import z from '@deepseek-ai/schemastery'

/** How a component chooses the presets it takes over. */
export type PresetsMode = 'list' | 'all' | 'none'

/**
 * Structural stand-in for DSH's `Volatile<T>` reference.
 *
 * The real type lives in `@deepseek-ai/cosmokit`, which is vendored inside
 * schemastery; naming it in an exported declaration would make the emitted
 * `.d.ts` reference a path consumers cannot resolve (TS2742). Only `get()` is
 * ever used, so the structural shape is enough.
 */
export interface VolatileRef<T> {
  /** @returns the current immutable snapshot of the referenced value. */
  get(): T
}

/** Component settings shared by every component. */
export interface ComponentCommonConfig {
  /** Take over the presets named by the global selection instead of this component's own. */
  readonly useGlobalPresets: boolean
  /** Own preset selection used when `useGlobalPresets` is false. */
  readonly presetsMode: PresetsMode
  /** Own preset ids, read only while `presetsMode` is `list`. */
  readonly presets: readonly string[]
}

/** agent-instructions-plus settings: where AGENTS.md files are discovered. */
export interface AgentInstructionsConfig extends ComponentCommonConfig {
  /** Scan the session working directory (highest priority). */
  readonly scanCwd: boolean
  /** Scan the nearest marker-bearing ancestor (medium, exclusive with scanParents). */
  readonly scanProject: boolean
  /** Walk every ancestor from cwd upward (medium, exclusive with scanProject). */
  readonly scanParents: boolean
  /** Scan the user home (lowest priority). */
  readonly scanGlobal: boolean
  /** Base instruction file candidates, in priority order. */
  readonly instructionFileCandidates: readonly string[]
  /** Local overlay candidates loaded after the base files of one directory. */
  readonly localInstructionFileCandidates: readonly string[]
  /** Directory entries that mark a project root while walking upward. */
  readonly projectRootMarkers: readonly string[]
  /** Harness home holding the fixed user-global instruction file. */
  readonly dshHome: string
  /** UTF-8 byte budget for one rendered instruction batch. */
  readonly maxBytes: number
  /** Maximum bytes read from one instruction file. */
  readonly maxSourceBytes: number
}

/** skill-filesystem-plus settings: where skills are discovered. */
export interface SkillFilesystemConfig extends ComponentCommonConfig {
  /** Scan the session working directory (highest priority). */
  readonly scanCwd: boolean
  /** Scan the nearest `.git`-bearing ancestor (medium, exclusive with scanParents). */
  readonly scanProject: boolean
  /** Walk every ancestor from cwd upward (medium, exclusive with scanProject). */
  readonly scanParents: boolean
  /** Scan the user home (lowest priority). */
  readonly scanGlobal: boolean
  /** Parent directories scanned as `<base>/<name>/skills`; index is priority. */
  readonly parentDirs: readonly { readonly name: string }[]
}

/** Every component's settings, keyed by component id. */
export interface ComponentsConfig {
  'agent-instructions-plus': AgentInstructionsConfig
  'skill-filesystem-plus': SkillFilesystemConfig
}

/** The core row's configuration as the Loader resolves it. */
export interface PluginsPlusConfig {
  /** Global preset selection every component inherits by default. */
  readonly presetsMode: VolatileRef<PresetsMode>
  /** Global preset ids, read only while `presetsMode` is `list`. */
  readonly presets: VolatileRef<readonly string[]>
  /** Per-component settings; the subtree is one volatile reference. */
  readonly components: VolatileRef<ComponentsConfig>
  /**
   * Timestamp of the one-shot import from the standalone plugins, empty when it
   * has not run. Kept in the configuration rather than a marker file so the
   * import is recorded per profile, and so re-importing can never resurrect a
   * value the user has since cleared.
   */
  readonly legacyImport: VolatileRef<string>
}

const DEFAULT_INSTRUCTION_FILE_CANDIDATES = ['AGENTS.md', 'CLAUDE.md']
const DEFAULT_LOCAL_INSTRUCTION_FILE_CANDIDATES = ['AGENTS.local.md', 'CLAUDE.local.md']
const DEFAULT_PROJECT_ROOT_MARKERS = ['.git']
const DEFAULT_PARENT_DIRS = [{ name: '.dsh' }, { name: '.agents' }]
const DEFAULT_MAX_BYTES = 65536
const DEFAULT_MAX_SOURCE_BYTES = 1048576

/** Defaults for one component section, used for display and normalization. */
export const COMPONENT_DEFAULTS: ComponentsConfig = {
  'agent-instructions-plus': {
    useGlobalPresets: true,
    presetsMode: 'list',
    presets: [],
    scanCwd: true,
    scanProject: true,
    scanParents: false,
    scanGlobal: true,
    instructionFileCandidates: DEFAULT_INSTRUCTION_FILE_CANDIDATES,
    localInstructionFileCandidates: DEFAULT_LOCAL_INSTRUCTION_FILE_CANDIDATES,
    projectRootMarkers: DEFAULT_PROJECT_ROOT_MARKERS,
    dshHome: '~/.dsh',
    maxBytes: DEFAULT_MAX_BYTES,
    maxSourceBytes: DEFAULT_MAX_SOURCE_BYTES,
  },
  'skill-filesystem-plus': {
    useGlobalPresets: true,
    presetsMode: 'list',
    presets: [],
    scanCwd: true,
    scanProject: true,
    scanParents: false,
    scanGlobal: true,
    parentDirs: DEFAULT_PARENT_DIRS,
  },
}

/** Global defaults for the core row. */
export const CORE_DEFAULTS = {
  presetsMode: 'list' as PresetsMode,
  presets: [] as string[],
}

const presetsModeField = () =>
  z.union([z.const('list'), z.const('all'), z.const('none')]).default('list')

const componentCommonFields = {
  useGlobalPresets: z.boolean().default(true),
  presetsMode: presetsModeField(),
  presets: z.array(z.string()).default([]),
}

/**
 * The core row's schema: the single declared home of every configuration value.
 *
 * Declared as `z<PluginsPlusConfig>` so the generated `.d.ts` names the type
 * instead of expanding schemastery's inference (which would reference the
 * vendored cosmokit path and fail declaration emit).
 */
export const Config = z.object({
  presetsMode: presetsModeField().volatile(),
  presets: z.array(z.string()).default([]).volatile(),
  legacyImport: z.string().default('').hidden().volatile(),
  components: z
    .object({
      'agent-instructions-plus': z.object({
        ...componentCommonFields,
        scanCwd: z.boolean().default(true),
        scanProject: z.boolean().default(true),
        scanParents: z.boolean().default(false),
        scanGlobal: z.boolean().default(true),
        instructionFileCandidates: z.array(z.string()).default([...DEFAULT_INSTRUCTION_FILE_CANDIDATES]),
        localInstructionFileCandidates: z.array(z.string()).default([...DEFAULT_LOCAL_INSTRUCTION_FILE_CANDIDATES]),
        projectRootMarkers: z.array(z.string()).default([...DEFAULT_PROJECT_ROOT_MARKERS]),
        dshHome: z.string().default('~/.dsh'),
        maxBytes: z.number().default(DEFAULT_MAX_BYTES),
        maxSourceBytes: z.number().default(DEFAULT_MAX_SOURCE_BYTES),
      }),
      'skill-filesystem-plus': z.object({
        ...componentCommonFields,
        scanCwd: z.boolean().default(true),
        scanProject: z.boolean().default(true),
        scanParents: z.boolean().default(false),
        scanGlobal: z.boolean().default(true),
        parentDirs: z.array(z.object({ name: z.string() })).default([...DEFAULT_PARENT_DIRS]),
      }),
    })
    .volatile(),
}) as unknown as z<PluginsPlusConfig>

// ── Reading volatile references ──────────────────────────────────────

/** Duck-type a DSH volatile config reference (`Volatile<T>` is `{ get() }`). */
function isVolatileRef(value: unknown): value is VolatileRef<unknown> {
  return (
    typeof value === 'object' &&
    value !== null &&
    !Array.isArray(value) &&
    typeof (value as { get?: unknown }).get === 'function'
  )
}

/**
 * Read one configuration field, whether the Loader handed us a volatile
 * reference or a plain value (the latter happens in tests and in any
 * composition that mounts this plugin without the Loader).
 * @param value - resolved field (reference or plain).
 * @param fallback - value used when the reference holds nothing.
 * @returns the current plain value.
 */
export function readConfigValue<T>(value: VolatileRef<T> | T, fallback: T): T {
  if (isVolatileRef(value)) {
    try {
      const snapshot = value.get()
      return snapshot === undefined || snapshot === null ? fallback : (snapshot as T)
    } catch {
      return fallback
    }
  }
  return (value ?? fallback) as T
}

/** A plain, fully resolved view of the core configuration. */
export interface PluginsPlusSnapshot {
  presetsMode: PresetsMode
  presets: readonly string[]
  components: ComponentsConfig
  /** Timestamp of the standalone-plugin import, empty when it has not run. */
  legacyImport: string
}

/**
 * Resolve the whole configuration into plain values.
 * @param config - the core row's resolved config.
 * @returns the snapshot every reader works from.
 */
export function readSnapshot(config: PluginsPlusConfig | undefined): PluginsPlusSnapshot {
  if (config === undefined) {
    return {
      presetsMode: CORE_DEFAULTS.presetsMode,
      presets: [],
      components: COMPONENT_DEFAULTS,
      legacyImport: '',
    }
  }
  return {
    presetsMode: normalizePresetsMode(readConfigValue(config.presetsMode, CORE_DEFAULTS.presetsMode)),
    presets: normalizePresetList(readConfigValue(config.presets, CORE_DEFAULTS.presets)),
    components: normalizeComponents(readConfigValue(config.components, COMPONENT_DEFAULTS)),
    legacyImport: readConfigValue(config.legacyImport, ''),
  }
}

/** Narrow an unknown value to a preset selection mode. */
export function normalizePresetsMode(value: unknown): PresetsMode {
  return value === 'all' || value === 'none' || value === 'list' ? value : 'list'
}

/** Drop empty and duplicate preset ids, preserving order. */
export function normalizePresetList(value: unknown): string[] {
  if (!Array.isArray(value)) return []
  const seen = new Set<string>()
  const out: string[] = []
  for (const entry of value) {
    if (typeof entry !== 'string') continue
    const id = entry.trim()
    if (id.length === 0 || seen.has(id)) continue
    seen.add(id)
    out.push(id)
  }
  return out
}

const RESERVED_PATH_SEGMENTS = new Set(['', '.', '..'])

/** Keep usable candidate names: non-empty, no path separators, no dot segments. */
function normalizeCandidates(value: unknown, fallback: readonly string[]): string[] {
  if (!Array.isArray(value)) return [...fallback]
  const cleaned = value
    .filter((entry): entry is string => typeof entry === 'string')
    .map(entry => entry.trim())
    .filter(entry => entry.length > 0 && !RESERVED_PATH_SEGMENTS.has(entry) && !/[\\/]/.test(entry))
  return cleaned.length > 0 ? cleaned : [...fallback]
}

function normalizePositiveNumber(value: unknown, fallback: number): number {
  return typeof value === 'number' && Number.isFinite(value) && value > 0 ? value : fallback
}

/**
 * Normalize a scan-layer selection: `scanParents` and `scanProject` are
 * mutually exclusive, and the UI cannot always prevent a hand-edited patch
 * from setting both. `scanParents` wins — it is the superset that the user
 * explicitly opted into.
 */
function normalizeScanLayers(source: {
  scanCwd?: unknown
  scanProject?: unknown
  scanParents?: unknown
  scanGlobal?: unknown
}): { scanCwd: boolean; scanProject: boolean; scanParents: boolean; scanGlobal: boolean } {
  const scanParents = source.scanParents === true
  return {
    scanCwd: source.scanCwd !== false,
    scanProject: scanParents ? false : source.scanProject !== false,
    scanParents,
    scanGlobal: source.scanGlobal !== false,
  }
}

/**
 * Normalize the component subtree against its defaults.
 * @param value - raw subtree (plain or resolved).
 * @returns a complete, safe component configuration.
 */
export function normalizeComponents(value: unknown): ComponentsConfig {
  const source = (value && typeof value === 'object' ? value : {}) as Record<string, unknown>
  const instructions = (source['agent-instructions-plus'] ?? {}) as Record<string, unknown>
  const skills = (source['skill-filesystem-plus'] ?? {}) as Record<string, unknown>
  const instructionDefaults = COMPONENT_DEFAULTS['agent-instructions-plus']
  const skillDefaults = COMPONENT_DEFAULTS['skill-filesystem-plus']

  return {
    'agent-instructions-plus': {
      useGlobalPresets: instructions.useGlobalPresets !== false,
      presetsMode: normalizePresetsMode(instructions.presetsMode),
      presets: normalizePresetList(instructions.presets),
      ...normalizeScanLayers(instructions),
      instructionFileCandidates: normalizeCandidates(
        instructions.instructionFileCandidates,
        instructionDefaults.instructionFileCandidates,
      ),
      localInstructionFileCandidates: normalizeCandidates(
        instructions.localInstructionFileCandidates,
        instructionDefaults.localInstructionFileCandidates,
      ),
      projectRootMarkers: normalizeCandidates(instructions.projectRootMarkers, instructionDefaults.projectRootMarkers),
      dshHome:
        typeof instructions.dshHome === 'string' && instructions.dshHome.trim().length > 0
          ? instructions.dshHome.trim()
          : instructionDefaults.dshHome,
      maxBytes: normalizePositiveNumber(instructions.maxBytes, instructionDefaults.maxBytes),
      maxSourceBytes: normalizePositiveNumber(instructions.maxSourceBytes, instructionDefaults.maxSourceBytes),
    },
    'skill-filesystem-plus': {
      useGlobalPresets: skills.useGlobalPresets !== false,
      presetsMode: normalizePresetsMode(skills.presetsMode),
      presets: normalizePresetList(skills.presets),
      ...normalizeScanLayers(skills),
      parentDirs: normalizeParentDirs(skills.parentDirs, skillDefaults.parentDirs),
    },
  }
}

/** Keep parent directory names usable as one path segment. */
export function normalizeParentDirs(
  value: unknown,
  fallback: readonly { readonly name: string }[] = DEFAULT_PARENT_DIRS,
): { name: string }[] {
  if (!Array.isArray(value)) return fallback.map(entry => ({ name: entry.name }))
  const out: { name: string }[] = []
  const seen = new Set<string>()
  for (const entry of value) {
    const name =
      typeof entry === 'string'
        ? entry.trim()
        : typeof (entry as { name?: unknown })?.name === 'string'
          ? ((entry as { name: string }).name).trim()
          : ''
    if (name.length === 0 || seen.has(name) || name.includes('/') || name.includes('\\')) continue
    seen.add(name)
    out.push({ name })
  }
  return out.length > 0 ? out : fallback.map(entry => ({ name: entry.name }))
}

/** The preset selection one component actually uses. */
export interface EffectivePresetSelection {
  /** Whether the value came from the global selection. */
  readonly inherited: boolean
  readonly mode: PresetsMode
  readonly presets: readonly string[]
}

/**
 * Resolve one component's preset selection: its own when it opts out of the
 * global selection, the global one otherwise.
 * @param snapshot - resolved core configuration.
 * @param componentId - component to resolve.
 * @returns the effective selection with its source.
 */
export function effectivePresetSelection(
  snapshot: PluginsPlusSnapshot,
  componentId: keyof ComponentsConfig,
): EffectivePresetSelection {
  const component = snapshot.components[componentId]
  if (component.useGlobalPresets) {
    return { inherited: true, mode: snapshot.presetsMode, presets: snapshot.presets }
  }
  return { inherited: false, mode: component.presetsMode, presets: component.presets }
}
