/**
 * Running a takeover pass outside DSH's hot-reload transaction.
 *
 * DSH serializes module and configuration replacement through
 * `hmr.runExclusive`, guarded by an `AsyncLocalStorage` flag: a nested call is
 * refused with "HMR transactions cannot be nested". A Settings write runs
 * inside such a transaction, and **every callback scheduled from it inherits
 * that flag** — including a `setTimeout` created by the event handler that
 * noticed the write — so an engine pass started from a change notification
 * would be refused no matter how long it waited.
 *
 * The HMR service itself escapes its own flag with `AsyncLocalStorage.exit`
 * (it does so for its configuration watcher), and that is what this module
 * reuses: run the pass with the flag cleared so `configEditor.edit()` may take
 * the transaction the write has already released. The field is reached by
 * feature detection, so a host without HMR — or a future DSH that renames the
 * field — simply runs the pass directly, which is correct whenever the call did
 * not originate inside a transaction.
 *
 * @module @sidleo3/dsh-plugins-plus/hmr
 */

import type { Context } from '@deepseek-ai/cordis'

/** The escape hatch the HMR service exposes on its own instance. */
interface HmrEscape {
  executing?: {
    exit?: <T>(run: () => T) => T
  }
}

/**
 * Run one operation with DSH's HMR transaction flag cleared.
 * @param ctx - context that may carry the `hmr` service.
 * @param run - the operation; its whole async continuation inherits the cleared flag.
 * @returns the operation's result.
 */
export function outsideHmrTransaction<T>(ctx: Context, run: () => Promise<T>): Promise<T> {
  const hmr = ctx.get('hmr') as HmrEscape | undefined
  const executing = hmr?.executing
  const exit = executing?.exit
  if (typeof exit !== 'function') return run()
  try {
    return Promise.resolve(exit.call(executing, run)) as Promise<T>
  } catch {
    // A host that answers differently still gets the plain call.
    return run()
  }
}
