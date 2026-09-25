/**
 * skill-filesystem-plus activator row — @sidleo3/dsh-plugins-plus/skill-filesystem
 *
 * Loading this row registers the component with the bundle service, which is
 * what makes the takeover engine swap the built-in `skill-filesystem` row for
 * this bundle's four-layer provider inside the selected presets; unloading it
 * restores the built-in row.
 *
 * It holds no configuration of its own: every setting lives in the core row's
 * schema (Settings → DSH Plus), so the component can be configured before it is
 * switched on.
 *
 * @module @sidleo3/dsh-plugins-plus/skill-filesystem
 */

import type { Context } from '@deepseek-ai/cordis'
import { pluginsPlusService } from '../../core/registry.ts'

/** Component id, as the bundle patch and the configuration schema name it. */
export const COMPONENT_ID = 'skill-filesystem-plus'

export const name = 'skill-filesystem-plus'

/**
 * Register the component while this row is loaded.
 * @param ctx - the row's context.
 */
export function apply(ctx: Context): void {
  ctx.inject(['dshPluginsPlus'], sctx => {
    const service = pluginsPlusService(sctx)
    if (service === undefined) return
    const dispose = service.registerComponent(COMPONENT_ID)
    sctx.effect(() => () => {
      dispose()
    })
    ctx.logger?.info?.(`[dsh-plugins-plus] 组件已启用：${COMPONENT_ID}`)
  })
}
