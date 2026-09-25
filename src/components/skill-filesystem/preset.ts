/**
 * skill-filesystem-plus provider row — @sidleo3/dsh-plugins-plus/skill-filesystem/preset
 *
 * Session-plane entry, inserted by the takeover engine next to the disabled
 * `skill-filesystem` row of the presets the user selected. It registers the
 * four-layer discovery provider into THIS preset's layer of the skill registry,
 * which is what makes duplicate names resolve by rank instead of by layer.
 *
 * The scan settings come from the core row's service and are read on every
 * `list`, so a Settings edit reaches the next catalog refresh without a
 * restart. A session-plane row whose composition has no core row falls back to
 * its own config snapshot.
 *
 * @module @sidleo3/dsh-plugins-plus/skill-filesystem/preset
 */

import type { Context } from '@deepseek-ai/cordis'
import type { SkillProviderControl } from '@deepseek-ai/dsh-skill'
import { pluginsPlusService } from '../../core/registry.ts'
import { DEFAULT_SCAN_CONFIG, type SkillScanConfig } from './config.ts'
import { makeSkillProvider, resolveUserHome, type ProviderFs } from './provider.ts'
import { SkillWatcher } from './watcher.ts'

export const name = 'skill-filesystem-plus'
export const inject = ['skills']

/**
 * Register the discovery provider while this preset layer is mounted.
 * @param ctx - the row's context, which must provide `skills`.
 * @param config - the row's own settings, used only when the core row is absent.
 */
export function apply(ctx: Context, config: Partial<SkillScanConfig> = {}): void {
  const skills = ctx.get('skills')
  if (skills === undefined) return

  const service = pluginsPlusService(ctx)
  const fallback: SkillScanConfig = { ...DEFAULT_SCAN_CONFIG, ...config }
  const readConfig = (): SkillScanConfig => {
    if (service === undefined) return fallback
    try {
      return service.skillConfig()
    } catch {
      return fallback
    }
  }

  const fs = ctx.get('fs') as ProviderFs | undefined
  let control: SkillProviderControl | undefined

  // Watch the roots the latest scan used, so skills added by an IDE, git, or a
  // shell command reach the catalog: the first-party `fs/observed` events only
  // cover the model's own writes. Editing the scan layers re-arms the watcher.
  const logger = (ctx as unknown as { logger?: { warn(message: string): void } }).logger
  const watcher = new SkillWatcher(() => control?.invalidate(), logger)

  const provider = makeSkillProvider(readConfig, {
    fs,
    home: () => resolveUserHome(ctx as unknown as { get(name: string): unknown }),
    onRoots: roots => {
      void watcher.observeRoots(roots.map(root => root.root))
    },
  })

  const unregister = skills.registerProvider(control_ => {
    control = control_
    return provider
  })

  // `fs/observed` is augmented by dsh-fs, which this package does not depend on
  // at type level; cast to the runtime event shape.
  const listen = (ctx as unknown as {
    on(name: string, listener: (target: unknown, observation: unknown, actor: unknown) => void): unknown
  }).on.bind(ctx)
  listen('fs/observed', (_target: unknown, _observation: unknown, actor: unknown) => {
    const actorName =
      actor && typeof actor === 'object' && 'name' in actor
        ? ((actor as { name?: unknown }).name as string | undefined)
        : undefined
    if (actorName !== 'write' && actorName !== 'edit') return
    control?.invalidate()
  })

  // Cordis effect disposal: release every watcher handle on unload, or a
  // disabled preset would leak handles across reloads.
  const effect = (ctx as unknown as { effect?: (fn: () => () => void) => unknown }).effect
  if (typeof effect === 'function') {
    effect.call(ctx, () => () => {
      void watcher.dispose()
    })
  }

  void unregister
}
