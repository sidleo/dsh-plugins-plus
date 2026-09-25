/**
 * The bundle's read-only browser surface.
 *
 * Everything the user *changes* goes through DSH's own configuration pipeline
 * (`ctx.configForms` in the browser → the settings document → the config
 * editor → the profile patch), so this module only answers questions the
 * client cannot compute: which presets exist, what each one currently runs,
 * which components are mounted, and what the takeover engine has been doing
 * (plain text, for the configuration page's log link). One POST route exists to
 * ask the engine for another pass after a manual patch edit.
 *
 * Routes must stay unique — registering the same path twice throws — and every
 * route answers JSON (the log answers text), so the client can render a failure
 * instead of a blank page.
 *
 * @module @sidleo3/dsh-plugins-plus/rpc
 */

import type { Context } from '@deepseek-ai/cordis'

/** The subset of `ctx.webServer` this package uses. */
export interface WebServerLike {
  register(route: {
    kind: string
    path: string
    handler: (req: HttpRequestLike, res: HttpResponseLike) => void | Promise<void>
  }): () => void
}

interface HttpRequestLike {
  method?: string
  url?: string
  on?: (event: 'data' | 'end' | 'error', callback: (chunk?: unknown) => void) => void
}

interface HttpResponseLike {
  writeHead: (code: number, headers: Record<string, string>) => void
  end: (body: string) => void
}

/** The API prefix every route of this bundle lives under. */
export const API_PREFIX = '/api/dsh-plugins-plus'

/** What the host answers the browser. */
export interface RpcHandlers {
  /** Everything the configuration page needs to render status. */
  status(): Promise<unknown>
  /** The engine's run log as plain text, behind the page's log link. */
  log(): Promise<string>
  /** Run one engine pass now, after a manual patch edit. */
  reconcile(): Promise<unknown>
}

/** Drain a JSON request body. */
async function readBody(req: HttpRequestLike): Promise<string> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = []
    req.on?.('data', chunk => {
      chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(String(chunk)))
    })
    req.on?.('end', () => resolve(Buffer.concat(chunks).toString('utf8')))
    req.on?.('error', reject)
  })
}

function sendJson(res: HttpResponseLike, body: unknown, code = 200): void {
  res.writeHead(code, { 'content-type': 'application/json', 'cache-control': 'no-store' })
  res.end(JSON.stringify(body))
}

function sendText(res: HttpResponseLike, body: string, code = 200): void {
  res.writeHead(code, { 'content-type': 'text/plain; charset=utf-8', 'cache-control': 'no-store' })
  res.end(body)
}

/**
 * Register the bundle's routes.
 * @param ctx - plugin context providing `webServer`.
 * @param handlers - the host-side answers.
 * @returns whether the routes were registered.
 */
export function registerRoutes(ctx: Context, handlers: RpcHandlers): boolean {
  const webServer = ctx.get('webServer') as WebServerLike | undefined
  if (webServer?.register === undefined) return false

  const guard = (
    name: string,
    run: (req: HttpRequestLike) => Promise<unknown>,
  ): ((req: HttpRequestLike, res: HttpResponseLike) => Promise<void>) => {
    return async (req, res) => {
      try {
        sendJson(res, await run(req))
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error)
        ctx.logger?.warn?.(`[dsh-plugins-plus] ${name} failed: ${message}`)
        sendJson(res, { ok: false, error: message }, 500)
      }
    }
  }

  webServer.register({
    kind: 'exact',
    path: `${API_PREFIX}/status`,
    handler: guard('status', () => handlers.status()),
  })

  webServer.register({
    kind: 'exact',
    path: `${API_PREFIX}/log`,
    handler: async (req, res) => {
      const method = req.method?.toUpperCase()
      if (method !== undefined && method !== 'GET' && method !== 'HEAD') {
        sendText(res, 'GET required', 405)
        return
      }
      try {
        sendText(res, await handlers.log())
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error)
        ctx.logger?.warn?.(`[dsh-plugins-plus] log failed: ${message}`)
        sendText(res, `读取运行日志失败：${message}`, 500)
      }
    },
  })

  webServer.register({
    kind: 'exact',
    path: `${API_PREFIX}/reconcile`,
    handler: guard('reconcile', async req => {
      const method = req.method?.toUpperCase()
      if (method !== undefined && method !== 'POST') {
        throw new Error('POST required')
      }
      // Drain the body so the socket is reusable even when the client sent one.
      await readBody(req).catch(() => '')
      return handlers.reconcile()
    }),
  })

  return true
}
