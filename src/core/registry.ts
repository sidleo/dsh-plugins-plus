/**
 * The bundle's runtime service: configuration snapshots, component registry,
 * and the trigger the takeover engine runs on.
 *
 * The core row provides it; the component activator rows register into it
 * (their presence is what "component enabled" means), and the session-plane
 * pipeline rows read their effective settings from it on every use, so a
 * Settings edit reaches the next scan or injection without a restart and
 * without either row reading files itself.
 *
 * @module @sidleo3/dsh-plugins-plus/registry
 */

import { Service, type Context } from '@deepseek-ai/cordis'
import type {
  AgentInstructionsConfig,
  ComponentsConfig,
  EffectivePresetSelection,
  PluginsPlusConfig,
  PluginsPlusSnapshot,
  SkillFilesystemConfig,
} from './config.ts'
import {
  effectivePresetSelection,
  normalizeParentDirs,
  readSnapshot,
} from './config.ts'
import type { ReconcileReport } from './takeover.ts'

/** Service key every row of this bundle reaches the bundle through. */
export const SERVICE_NAME = 'dshPluginsPlus'

/** The engine's two entry points, attached by the core row after it starts. */
export interface EngineHooks {
  /** Ask for a pass soon; the engine owns the debounce. */
  trigger(reason: string): void
  /** Run one pass now and answer its report. */
  runNow(reason: string): Promise<ReconcileReport | undefined>
}

/** One component as the UI and the engine see it. */
export interface ComponentView {
  readonly id: string
  /** Whether the component's activator row is loaded right now. */
  readonly mounted: boolean
  /** Whether it has been loaded at least once in this process. */
  readonly everMounted: boolean
  /** Preset selection in force, with its source. */
  readonly selection: EffectivePresetSelection
}

/** The bundle service: configuration plus component registry. */
export class PluginsPlusService extends Service {
  private readonly config: PluginsPlusConfig
  private readonly mountedIds = new Set<string>()
  private readonly everMountedIds = new Set<string>()
  private hooks: EngineHooks | undefined

  /**
   * @param ctx - the core row's context; the service unregisters with it.
   * @param config - the core row's resolved config, volatile references intact.
   */
  constructor(ctx: Context, config: PluginsPlusConfig) {
    super(ctx, SERVICE_NAME)
    this.config = config
  }

  /** Attach the engine's entry points; called once by the core row. */
  attachEngine(hooks: EngineHooks): void {
    this.hooks = hooks
  }

  /** Ask the engine for a pass soon (debounced); a no-op without an engine. */
  requestReconcile(reason: string): void {
    this.hooks?.trigger(reason)
  }

  /** Run one engine pass now; resolves to undefined without an engine. */
  requestReconcileNow(reason: string): Promise<ReconcileReport | undefined> {
    if (this.hooks === undefined) return Promise.resolve(undefined)
    return this.hooks.runNow(reason)
  }

  /** @returns the whole configuration as plain values. */
  snapshot(): PluginsPlusSnapshot {
    return readSnapshot(this.config)
  }

  /** @returns every component this bundle ships, mounted or not. */
  componentView(ids: readonly string[]): ComponentView[] {
    const snapshot = this.snapshot()
    return ids.map(id => ({
      id,
      mounted: this.mountedIds.has(id),
      everMounted: this.everMountedIds.has(id),
      selection: effectivePresetSelection(snapshot, id as keyof ComponentsConfig),
    }))
  }

  /** @returns the ids of the components whose activator row is loaded. */
  mountedComponents(): ReadonlySet<string> {
    return this.mountedIds
  }

  /** @returns the ids of the components that mounted at least once in this process. */
  everMountedComponents(): ReadonlySet<string> {
    return this.everMountedIds
  }

  /** @returns the preset selection one component uses. */
  selection(componentId: string): EffectivePresetSelection {
    return effectivePresetSelection(this.snapshot(), componentId as keyof ComponentsConfig)
  }

  /** @returns the instruction-discovery settings in force. */
  instructionConfig(): AgentInstructionsConfig {
    return this.snapshot().components['agent-instructions-plus']
  }

  /** @returns the skill-discovery settings in force. */
  skillConfig(): SkillFilesystemConfig {
    // Normalized on read so a hand-edited patch can never hand the scanner an
    // unusable parent-dir list.
    const config = this.snapshot().components['skill-filesystem-plus']
    return { ...config, parentDirs: normalizeParentDirs(config.parentDirs) }
  }

  /**
   * Register a mounted component until its row unloads.
   * @param componentId - component id, as declared in the bundle patch.
   * @returns the disposer the caller wraps in its own effect.
   */
  registerComponent(componentId: string): () => void {
    this.mountedIds.add(componentId)
    this.everMountedIds.add(componentId)
    this.notify('component-mounted')
    return () => {
      this.mountedIds.delete(componentId)
      this.notify('component-unmounted')
    }
  }

  /**
   * Announce that the configuration moved — a `loader/volatile-update`, a
   * Settings write, or a first read after mount. The engine debounces the
   * actual pass, so repeated announcements cost nothing.
   * @param reason - short label recorded by the engine.
   */
  announce(reason: string): void {
    this.notify(reason)
  }

  /**
   * Hand an event to the engine. The trigger is the only path from a change to
   * a takeover pass, so a service built without one (tests, a composition that
   * mounts only the pipelines) simply does nothing here.
   */
  private notify(reason: string): void {
    try {
      this.hooks?.trigger(reason)
    } catch (error) {
      this.ctx.logger?.warn?.(`[dsh-plugins-plus] reconcile trigger failed (${reason}): ${String(error)}`)
    }
  }
}

/**
 * Reach the bundle service from any row of this bundle.
 * @param ctx - a row's context (core, activator, or session plane).
 * @returns the service, or undefined when the core row is not loaded.
 */
export function pluginsPlusService(ctx: Context): PluginsPlusService | undefined {
  return ctx.get(SERVICE_NAME) as PluginsPlusService | undefined
}
