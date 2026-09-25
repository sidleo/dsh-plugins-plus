/**
 * agent-instructions-plus injection pipeline — @sidleo3/dsh-plugins-plus/agent-instructions/preset
 *
 * Session-plane entry, inserted by the takeover engine next to the disabled
 * `agent-instructions` row of the presets the user selected. Replicates the
 * dsh-agent-instructions runtime: baseline composition into the first request,
 * incremental reconciliation after file touches, and a per-scope metadata
 * cache — but discovery, precedence, and budget follow this bundle's settings.
 *
 * The settings come from the core row's service and are read on every
 * injection, so a Settings edit takes effect on the very next pre-step without
 * a restart. When the core row is absent (a hand-written composition) this
 * row's own config is the fallback.
 *
 * @module @sidleo3/dsh-plugins-plus/agent-instructions/preset
 */

import type { Context } from '@deepseek-ai/cordis'
import { isDeepStrictEqual } from 'node:util'
import type { Agent, PreStepDecision } from '@deepseek-ai/dsh-agent'
import { createUserMessage } from '@deepseek-ai/dsh-llm'
import type { Session, UserMessage } from '@deepseek-ai/dsh-session'
import type { ToolExecution, ToolExecutionResult, ToolExecutionToken } from '@deepseek-ai/dsh-tools'
import { pluginsPlusService } from '../../core/registry.ts'
import { DEFAULT_CONFIG, normalizeConfig, type InstructionScanConfig } from './config.ts'
import { scanDirectories, scanDisplayBase } from './discovery.ts'
import {
  loadBaselineInstructionSet,
  userGlobalDisplayPath,
} from './files.ts'
import {
  applyInstructionVersionUpdates,
  baselineInstructionState,
  reconcileInstructionContext,
  workspaceContextMessage,
  type InstructionVersionCache,
  type AgentInstructionSource,
} from './state.ts'
import type { AgentInstructionChange } from './render.ts'

export const name = 'agent-instructions-plus'

/**
 * Settings this pipeline uses.
 *
 * They live in the core row's configuration (`components["agent-instructions-plus"]`)
 * and are handed over by the bundle service, which reads its volatile
 * references on every call — so an edit in Settings is visible to the very next
 * injection. A composition that mounts this row without the core plugin keeps
 * working from the row's own config.
 * @param ctx - pipeline context.
 * @param fallback - settings to use when the core row is absent.
 * @returns the settings in force.
 */
function readConfig(ctx: Context, fallback: InstructionScanConfig): InstructionScanConfig {
  const service = pluginsPlusService(ctx)
  if (service === undefined) return fallback
  try {
    return normalizeConfig({ ...fallback, ...service.instructionConfig() })
  } catch {
    return fallback
  }
}

function visibleBaselineSource(
  agent: Agent,
  authorityMessages: readonly UserMessage[],
): AgentInstructionSource | undefined {
  for (const message of authorityMessages.toReversed()) {
    if (message.source.kind === 'agent-instructions' && message.source.baseline === true) {
      return message.source
    }
  }
  for (const seq of agent.session.surface.nodes.toReversed()) {
    const event = agent.session.eventAt(seq)
    if (event?.type === 'user/message'
      && event.data.source.kind === 'agent-instructions'
      && event.data.source.baseline === true) return event.data.source
  }
  return undefined
}

function isWorkspaceContext(message: UserMessage): boolean {
  return message.source.kind === 'agent-instructions'
}

/**
 * True when the message's source is OUR injection (carries the
 * `provider: instruction-scan` marker — the literal is kept for
 * compatibility with messages persisted by the old bundle). The built-in
 * dsh-agent-instructions row injects with kind `agent-instructions` but no
 * provider marker; we drop those in pre-step to avoid duplicate
 * workspace-instruction blocks.
 */
function isOwnInjection(message: UserMessage): boolean {
  const src = message.source as { provider?: unknown }
  return src.provider === 'instruction-scan'
}

function sameContextPayload(left: UserMessage, right: UserMessage): boolean {
  return isDeepStrictEqual(left.content, right.content)
    && isDeepStrictEqual(left.source, right.source)
}

const FILE_TOUCH_TOOL_NAMES = new Set(['read', 'write', 'edit'])

function filePathFromExecution(exec: ToolExecution): string | undefined {
  if (!FILE_TOUCH_TOOL_NAMES.has(exec.name)) return undefined
  if (typeof exec.arguments !== 'object' || exec.arguments === null) return undefined
  if (!('file_path' in exec.arguments) || typeof exec.arguments.file_path !== 'string') return undefined
  const filePath = exec.arguments.file_path.trim()
  return filePath.length > 0 ? filePath : undefined
}

/**
 * Baseline identity: any change in the effective config or the scanned
 * directory set invalidates a resumed baseline.
 */
function baselineIdentity(config: InstructionScanConfig, cwd: string): string {
  const dirs = scanDirectories(config, cwd).map(dir => dir.dir)
  return JSON.stringify({
    dirs,
    scanCwd: config.scanCwd,
    scanProject: config.scanProject,
    scanParents: config.scanParents,
    scanGlobal: config.scanGlobal,
    instructionFileCandidates: config.instructionFileCandidates,
    localInstructionFileCandidates: config.localInstructionFileCandidates,
    projectRootMarkers: config.projectRootMarkers,
    maxBytes: config.maxBytes,
    maxSourceBytes: config.maxSourceBytes,
  })
}

export function apply(ctx: Context, config: Partial<InstructionScanConfig> = {}): void {
  // The row's own config fills the gaps when the bundle service is absent.
  const presetConfig = normalizeConfig({ ...DEFAULT_CONFIG, ...config })
  const fallbackConfig = presetConfig
  const instructionVersions: InstructionVersionCache = new WeakMap()
  const baselinePreparations = new WeakMap<Session, {
    identity: string
    excludedScopes: ReadonlySet<string>
  }>()
  const projectionLifecycle = new AbortController()
  type ProjectionTouch = { agent: Agent; path: string }
  const executionTouches = new Map<ToolExecutionToken, ProjectionTouch[]>()
  ctx.effect(
    () => () => {
      projectionLifecycle.abort(new Error('agent-instructions-plus disposed'))
      executionTouches.clear()
    },
    'agent-instructions-plus.projectionLifecycle',
  )
  // Emit listeners are not awaited, so each projection must compose against the
  // inbox produced by earlier file results for the same agent.
  const projectionTails = new WeakMap<Agent, Promise<void>>()
  const openSteps = new WeakMap<Session, boolean>()
  const stepTouches = new WeakMap<Session, ProjectionTouch[]>()

  const compose = async (
    agent: Agent,
    signal: AbortSignal,
    claimed: readonly UserMessage[],
    pending: readonly UserMessage[],
    touchedPaths: readonly string[] = [],
  ): Promise<UserMessage | undefined> => {
    signal.throwIfAborted()
    // Read the live settings per injection: a Settings edit therefore takes
    // effect on the very next pre-step, no restart needed.
    const cfg = readConfig(ctx, fallbackConfig)
    if (cfg.maxBytes <= 0 || !Number.isFinite(cfg.maxBytes)) {
      return undefined
    }
    const fs = ctx.get('fs')
    if (fs === undefined) return undefined
    if (touchedPaths.length === 0 && pending.length > 0) return pending[0]
    const content: UserMessage['content'][number][] = []
    const changes: AgentInstructionChange[] = []
    let desiredBaseline = false
    const authorityMessages = [...claimed]
    /* v8 ignore next -- normal agents carry an absolute session cwd. */
    const cwd = agent.session.header.cwd ?? process.cwd()
    const identity = baselineIdentity(cfg, cwd)
    const visibleBaseline = visibleBaselineSource(agent, authorityMessages)
    const baselinePresent = visibleBaseline !== undefined
    const keepVisibleBaseline = visibleBaseline?.baselineIdentity === identity
    const prepared = baselinePreparations.get(agent.session)
    let excludedBaselineScopes = keepVisibleBaseline && prepared?.identity === identity
      ? prepared.excludedScopes
      : undefined
    let nextPreparation: { identity: string; excludedScopes: ReadonlySet<string> } | undefined
    if (!baselinePresent || !keepVisibleBaseline || excludedBaselineScopes === undefined) {
      const replacePreviousBaseline = baselinePresent && !keepVisibleBaseline
      const instructions = await loadBaselineInstructionSet(cfg, cwd, fs, {
        replacePreviousBaseline,
        signal,
      })
      const baseline = baselineInstructionState(instructions?.included ?? [])
      const observedBaseline = baselineInstructionState(instructions?.observed ?? [])
      const excludedScopes = new Set(observedBaseline.changes.keys())
      for (const scope of baseline.changes.keys()) excludedScopes.delete(scope)
      excludedBaselineScopes = excludedScopes
      nextPreparation = { identity, excludedScopes }
      let versionStates = instructionVersions.get(agent.session)
      if (versionStates === undefined && baseline.versions.size > 0) {
        versionStates = new Map()
        instructionVersions.set(agent.session, versionStates)
      }
      for (const [scope, state] of baseline.versions) versionStates?.set(scope, state)
      if (!keepVisibleBaseline && instructions !== undefined && instructions.rendered.text.length > 0) {
        const baselineContent = workspaceContextMessage(instructions.rendered.text).content
        content.push(...baselineContent)
        const replacementScopes = new Set(baseline.changes.keys())
        const replacementRemovals = replacePreviousBaseline
          ? visibleBaseline.changes.flatMap(change => (
            change.action === 'remove' || replacementScopes.has(change.scope)
              ? []
              : [{ action: 'remove' as const, scope: change.scope, path: change.path }]
          ))
          : []
        const baselineChanges = [...replacementRemovals, ...baseline.changes.values()]
        changes.push(...baselineChanges)
        authorityMessages.push(createUserMessage({
          content: baselineContent,
          source: {
            kind: 'agent-instructions',
            form: 'instructions',
            provider: 'instruction-scan',
            baseline: true,
            baselineIdentity: identity,
            changes: baselineChanges,
          },
        }))
        desiredBaseline = true
      }
    }
    const update = await reconcileInstructionContext(
      agent,
      cfg,
      instructionVersions,
      fs,
      {
        authorityMessages,
        scopeMessages: pending,
        includeBaselineScopes: keepVisibleBaseline,
        ...keepVisibleBaseline ? { excludedBaselineScopes } : {},
        touchedPaths,
        signal,
      },
    )
    if (update !== undefined) {
      content.push(...update.context.content)
      /* v8 ignore next -- reconciliation constructs only agent-instructions contexts. */
      if (update.context.source.kind === 'agent-instructions') {
        changes.push(...update.context.source.changes)
      }
      applyInstructionVersionUpdates(agent.session, update.versionUpdates, instructionVersions)
    }
    if (nextPreparation !== undefined) baselinePreparations.set(agent.session, nextPreparation)
    if (content.length === 0) return undefined
    return createUserMessage({
      content,
      source: {
        kind: 'agent-instructions',
        form: 'instructions',
        provider: 'instruction-scan',
        ...desiredBaseline ? { baseline: true } : {},
        ...desiredBaseline ? { baselineIdentity: identity } : {},
        changes,
      },
    })
  }

  const syncInbox = (agent: Agent, claimed: readonly UserMessage[], desired: UserMessage | undefined): void => {
    const pending = agent.inbox.nextStep.filter(isWorkspaceContext)
    const alreadySupplied = desired !== undefined && (
      claimed.some(message => sameContextPayload(message, desired))
      || agent.session.surface.nodes.some((seq) => {
        const event = agent.session.eventAt(seq)
        return event?.type === 'user/message' && sameContextPayload(event.data, desired)
      })
    )
    if (desired === undefined || alreadySupplied) {
      for (const message of pending) agent.inbox.remove(message.id)
      return
    }
    const reusable = pending.find(message => sameContextPayload(message, desired))
    if (reusable !== undefined) {
      for (const message of pending) {
        if (message !== reusable) agent.inbox.remove(message.id)
      }
      return
    }
    const replaced = pending[0]
    if (replaced === undefined) agent.inbox.prepend('next-step', desired)
    else agent.inbox.replace(replaced.id, desired)
    for (const message of pending.slice(1)) agent.inbox.remove(message.id)
  }

  const composeAndSync = async (
    agent: Agent,
    signal: AbortSignal,
    claimed: readonly UserMessage[],
    touchedPaths: readonly string[] = [],
  ): Promise<void> => {
    const pending = agent.inbox.nextStep.filter(isWorkspaceContext)
    const desired = await compose(agent, signal, claimed, pending, touchedPaths)
    signal.throwIfAborted()
    syncInbox(agent, claimed, desired)
  }

  const queueProjection = (
    agent: Agent,
    touchedPath: string,
  ): void => {
    const previous = projectionTails.get(agent) ?? Promise.resolve()
    const current = previous.then(() => composeAndSync(agent, projectionLifecycle.signal, [], [touchedPath]))
      .catch((error: unknown) => {
        if (!projectionLifecycle.signal.aborted) ctx.logger.warn('workspace instruction refresh failed: %o', error)
      })
    projectionTails.set(agent, current)
    void current.then(() => {
      if (projectionTails.get(agent) === current) projectionTails.delete(agent)
    })
  }

  const waitForProjections = async (agent: Agent): Promise<void> => {
    let projection: Promise<void> | undefined
    while ((projection = projectionTails.get(agent)) !== undefined) await projection
  }

  const stepIsOpen = (session: Session): boolean => {
    const known = openSteps.get(session)
    if (known !== undefined) return known
    let open = false
    for (const event of session.snapshotEvents()) {
      if (event.type === 'step/start') open = true
      else if (event.type === 'step/end' || event.type === 'turn/end') open = false
    }
    openSteps.set(session, open)
    return open
  }

  const projectTouch = (touch: ProjectionTouch): void => {
    const session = touch.agent.session
    if (!stepIsOpen(session)) {
      queueProjection(touch.agent, touch.path)
      return
    }
    const pending = stepTouches.get(session)
    if (pending === undefined) stepTouches.set(session, [touch])
    else pending.push(touch)
  }

  ctx.on('session/event', (session, event) => {
    if (event.type === 'step/start') {
      openSteps.set(session, true)
      return
    }
    if (event.type === 'turn/end') {
      openSteps.set(session, false)
      return
    }
    if (event.type !== 'step/end') return
    openSteps.set(session, false)
    const pending = stepTouches.get(session)
    if (pending === undefined) return
    stepTouches.delete(session)
    for (const touch of pending) queueProjection(touch.agent, touch.path)
  })

  ctx.on('agent/pre-step', async (
    { agent, messages, step, signal },
    next,
  ): Promise<PreStepDecision> => {
    const decision = await next()
    await waitForProjections(agent)
    const pending = agent.inbox.nextStep.filter(isWorkspaceContext)
    const desired = await compose(agent, signal, messages, pending)
    signal.throwIfAborted()
    // Drop workspace-instruction messages produced by OTHER providers (the
    // built-in dsh-agent-instructions row in each preset injects without a
    // `provider` marker). Our own injections carry `provider: instruction-scan`
    // and are folded below; removing the unmarked ones prevents duplicates.
    const decisionMessages = decision.kind === 'enter' ? decision.messages : []
    const cleanMessages = decisionMessages.filter((message: UserMessage) => (
      !isWorkspaceContext(message) || isOwnInjection(message)
    ))
    const decisionCleaned: PreStepDecision = cleanMessages.length === decisionMessages.length
      ? decision
      : { kind: 'enter', messages: cleanMessages }
    // An empty first entry owns a no-step turn; keep context pending instead
    // of turning it into a standalone request. Later entries may be tool continuations.
    if (decisionCleaned.kind === 'reject' || (step === 1 && decisionCleaned.messages.length === 0)) {
      syncInbox(agent, messages, desired)
      return decisionCleaned
    }
    // A proceeding step settles the pending context: it either enters below as
    // `desired`, or its payload is already covered by the batch, so nothing stays pending.
    for (const message of pending) agent.inbox.remove(message.id)
    if (desired === undefined || decisionCleaned.messages.some(message => sameContextPayload(message, desired))) {
      return decisionCleaned
    }
    // Fold the context right after the claimed batch, so the direct prompt
    // precedes it and the driver-appended runtime context follows it.
    const lastClaimedIndex = decisionCleaned.messages.findLastIndex(message => messages.includes(message))
    const entered = decisionCleaned.messages.toSpliced(lastClaimedIndex + 1, 0, desired)
    return { kind: 'enter', messages: entered }
  })

  ctx.on('tools/result', (exec: ToolExecution, result: ToolExecutionResult) => {
    const touches = executionTouches.get(exec.token) ?? []
    executionTouches.delete(exec.token)
    if (!result.isError && exec.agent !== undefined && !exec.signal.aborted) {
      const ownPath = filePathFromExecution(exec)
      if (ownPath !== undefined) touches.push({ agent: exec.agent, path: ownPath })
    }
    if (exec.parent !== undefined) {
      if (touches.length > 0) {
        const parentTouches = executionTouches.get(exec.parent)
        if (parentTouches === undefined) executionTouches.set(exec.parent, touches)
        else parentTouches.push(...touches)
      }
      return
    }
    for (const touch of touches) projectTouch(touch)
  })
}

/** Re-export the helper used by the host entry to display scan roots. */
export { scanDisplayBase, userGlobalDisplayPath }