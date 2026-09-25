/**
 * The component table: what each switchable component replaces and how.
 *
 * A component is one Loader row. Its id is `"<built-in row id>-plus"` (the
 * naming rule the user asked for), the row is shipped disabled so a profile
 * turns on exactly the components it wants, and enabling it makes the takeover
 * engine swap the built-in row for this bundle's session-plane pipeline inside
 * the presets the configuration selects.
 *
 * Adding a component later means adding one entry here, one row in
 * `cordis.patch.yml`, one export in `package.json` and one UI section — no new
 * package, no change to any profile's bundle list.
 *
 * @module @sidleo3/dsh-plugins-plus/components
 */

/** One switchable component of this bundle. */
export interface ComponentDescriptor {
  /** Loader row id of the component's activator, and its key in `config.components`. */
  readonly id: string
  /** Id of the built-in Loader row this component replaces inside a preset. */
  readonly builtinRowId: string
  /** Id the engine writes for the session-plane row it adds to a preset. */
  readonly pipelineRowId: string
  /** Module the session-plane row loads. */
  readonly pipelineModule: string
  /** Row ids earlier releases used for the same job (rewritten, never duplicated). */
  readonly legacyPipelineRowIds: readonly string[]
  /** Modules earlier releases wrote into those rows. */
  readonly legacyPipelineModules: readonly string[]
}

/** Every component this bundle ships and understands. */
export const COMPONENTS: readonly ComponentDescriptor[] = [
  {
    id: 'agent-instructions-plus',
    builtinRowId: 'agent-instructions',
    pipelineRowId: 'dsh-plugins-plus-agent-instructions',
    pipelineModule: '@sidleo3/dsh-plugins-plus/agent-instructions/preset',
    legacyPipelineRowIds: ['agent-instructions-plus-pipeline'],
    legacyPipelineModules: ['@sidleo3/agent-instructions-plus/preset'],
  },
  {
    id: 'skill-filesystem-plus',
    builtinRowId: 'skill-filesystem',
    pipelineRowId: 'dsh-plugins-plus-skill-filesystem',
    pipelineModule: '@sidleo3/dsh-plugins-plus/skill-filesystem/preset',
    legacyPipelineRowIds: ['skill-filesystem-plus-pipeline'],
    legacyPipelineModules: ['@sidleo3/skill-filesystem-plus/preset'],
  },
]

/** @returns the descriptor for one component id, if this bundle ships it. */
export function componentById(id: string): ComponentDescriptor | undefined {
  return COMPONENTS.find(component => component.id === id)
}

/** @returns every row id one component owns inside a preset. */
export function ownedPipelineRowIds(component: ComponentDescriptor): readonly string[] {
  return [component.pipelineRowId, ...component.legacyPipelineRowIds]
}
