/**
 * agent-instructions-plus activator row — @sidleo3/dsh-plugins-plus/agent-instructions
 *
 * The row exists so the component can be switched on and off from the Plugins
 * page like any other plugin entry: loading it registers the component with the
 * bundle service, which is what makes the takeover engine swap the built-in
 * `agent-instructions` row for this bundle's injection pipeline inside the
 * selected presets. Unloading it is equally meaningful — the engine then
 * restores the built-in row.
 *
 * It holds no configuration of its own: every setting lives in the core row's
 * schema (Settings → DSH Plus), so the component can be configured before it is
 * switched on.
 *
 * @module @sidleo3/dsh-plugins-plus/agent-instructions
 */

import type { Context } from '@deepseek-ai/cordis'
import { pluginsPlusService } from '../../core/registry.ts'

/** Component id, as the bundle patch and the configuration schema name it. */
export const COMPONENT_ID = 'agent-instructions-plus'

export const name = 'agent-instructions-plus'

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
