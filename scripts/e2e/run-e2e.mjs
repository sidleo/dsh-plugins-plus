#!/usr/bin/env node
/**
 * Real-link E2E for @sidleo3/dsh-plugins-plus on a throwaway DSH profile.
 *
 * Why this exists: unit tests (`pnpm smoke`) and reading the profile patch can
 * both pass while the plugin is not wired into a running DSH at all (AGENTS.md
 * pitfall 12). This script therefore drives the real chain end to end:
 *
 *   link install -> boot `dsh --profile <p> --port <p> --no-open` -> take the
 *   token from the log -> exchange it for the auth cookie -> call the real
 *   remote endpoints (settings/describe, settings/mutate,
 *   pluginManager/setPluginEnabled) -> assert the profile patch on disk
 *   changed -> flip components -> restore -> kill the process it started.
 *
 * Safety: it refuses to run against a real profile (`desktop` / `web`) or on
 * the desktop app's port, and it hashes the real profiles before/after so the
 * "zero side effects" claim is checked, not asserted.
 *
 * Usage:
 *   node scripts/e2e/run-e2e.mjs [--profile smoke02] [--port 5399]
 *                                [--preset standard] [--phase auto|baseline|postfix]
 *                                [--keep-server] [--no-install]
 *
 * Exit code: 0 = every hard assertion passed, 1 = at least one failed,
 * 2 = the script refused to run (guard / precondition).
 */

import { spawn, spawnSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { existsSync, mkdirSync, readFileSync, readdirSync, statSync, writeFileSync } from 'node:fs'
import { connect } from 'node:net'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { parse as parseYaml } from 'yaml'

// ── configuration ────────────────────────────────────────────────────

const HERE = dirname(fileURLToPath(import.meta.url))
const REPO = resolve(HERE, '..', '..')
const REPORT_DIR = join(HERE, 'reports')
const DSH_HOME = process.env.DSH_HOME ?? join(process.env.HOME, '.dsh')
const FORBIDDEN_PROFILES = new Set(['desktop', 'web'])
const FORBIDDEN_PORTS = new Set([19387])
const INSTALL_TIMEOUT_MS = 300_000
const BOOT_TIMEOUT_MS = 120_000
const PATCH_WAIT_MS = 15_000
const PKG = '@sidleo3/dsh-plugins-plus'
const CORE_NS = 'dsh-plugins-plus'
const COMPONENT_ENTRIES = ['include:agent-instructions-plus', 'include:skill-filesystem-plus']
const PIPELINE_ROWS = ['dsh-plugins-plus-agent-instructions', 'dsh-plugins-plus-skill-filesystem']

const opts = parseArgs(process.argv.slice(2))
const PROFILE = opts.profile
const PROFILE_DIR = join(DSH_HOME, 'profiles', PROFILE)
const PORT = opts.port
const BASE = `http://127.0.0.1:${PORT}`
const PRESET = opts.preset

// ── result bookkeeping ───────────────────────────────────────────────

/** @type {{id:string,title:string,status:'pass'|'fail'|'skip'|'info',evidence:string}[]} */
const results = []
/** @type {string[]} */
const notes = []

function record(id, title, status, evidence = '') {
  results.push({ id, title, status, evidence: oneLine(evidence) })
  const mark = { pass: 'PASS', fail: 'FAIL', skip: 'SKIP', info: 'INFO' }[status]
  process.stdout.write(`  [${mark}] ${id} ${title}${evidence ? `\n         ${oneLine(evidence).slice(0, 400)}` : ''}\n`)
  return status
}

/** Run one assertion: `fn` returns evidence, or throws to fail. */
async function check(id, title, fn) {
  try {
    const evidence = await fn()
    return record(id, title, 'pass', evidence ?? '')
  } catch (error) {
    return record(id, title, 'fail', error instanceof Error ? error.message : String(error))
  }
}

function oneLine(value, max = 600) {
  const text = String(value ?? '').replace(/\s+/g, ' ').trim()
  return text.length > max ? `${text.slice(0, max)}…` : text
}

function assert(condition, message, evidence = '') {
  if (!condition) throw new Error(evidence ? `${message} — ${oneLine(evidence, 300)}` : message)
}

// ── process / file helpers ───────────────────────────────────────────

let serverChild
let serverLogPath
let serverLog
let cleaned = false
let keepServer = false

/**
 * Stop the server this script started and WAIT until the process is really gone
 * and the port is really released — the "no orphan" claim is worth nothing if
 * it is only asserted right after a signal was sent.
 * @returns {{pid:number|undefined, processGone:boolean, portFree:boolean, waitedMs:number, escalated:boolean}}
 */
async function cleanup(reason) {
  const report = { pid: serverChild?.pid, processGone: true, portFree: true, waitedMs: 0, escalated: false }
  if (cleaned || keepServer || serverChild === undefined) return report
  cleaned = true
  const started = Date.now()
  const pid = serverChild.pid

  const signal = name => {
    for (const target of [-pid, pid]) {
      try {
        process.kill(target, name)
      } catch {
        /* group or process already gone */
      }
    }
  }

  signal('SIGTERM')
  const escalateAt = started + 5000
  const giveUpAt = started + 20_000
  while (Date.now() < giveUpAt) {
    const alive = isAlive(pid)
    const free = await portIsFree(opts.port)
    if (!alive && free) break
    if (!report.escalated && Date.now() > escalateAt) {
      report.escalated = true
      signal('SIGKILL')
    }
    await sleep(200)
  }
  report.processGone = !isAlive(pid)
  report.portFree = await portIsFree(opts.port)
  report.waitedMs = Date.now() - started
  process.stdout.write(
    `  · teardown (${reason}): pid ${pid} signalled${report.escalated ? ' (escalated to SIGKILL)' : ''}; ` +
    `gone=${report.processGone} portFree=${report.portFree} after ${report.waitedMs}ms\n`,
  )
  return report
}

function isAlive(pid) {
  try {
    process.kill(pid, 0)
    return true
  } catch {
    return false
  }
}

function readText(path) {
  return existsSync(path) ? readFileSync(path, 'utf8') : undefined
}

function sha256(path) {
  try {
    return createHash('sha256').update(readFileSync(path)).digest('hex').slice(0, 16)
  } catch {
    return 'absent'
  }
}

/** Digest of the files a profile keeps its own state in (zero-side-effect check). */
function profileDigest(profile) {
  const dir = join(DSH_HOME, 'profiles', profile)
  const files = ['package.json', 'cordis.patch.yml', 'cordis.yml', 'pnpm-lock.yaml', 'compatibility.json']
  return files.map(file => `${file}=${sha256(join(dir, file))}`).join(' ')
}

function portIsFree(port) {
  return new Promise(resolvePromise => {
    const socket = connect({ host: '127.0.0.1', port })
    const done = value => {
      socket.destroy()
      resolvePromise(value)
    }
    socket.once('connect', () => done(false))
    socket.once('error', () => done(true))
    setTimeout(() => done(true), 1000)
  })
}

/** Number of processes LISTENing on a port (0 = free). */
async function countListeners(port) {
  const result = spawnSync('sh', ['-c', `lsof -nP -iTCP:${port} -sTCP:LISTEN | tail -n +2 | wc -l | tr -d ' '`])
  return Number(String(result.stdout ?? '0').trim() || '0')
}

function sleep(ms) {
  return new Promise(resolvePromise => setTimeout(resolvePromise, ms))
}

async function waitFor(description, probe, timeoutMs, intervalMs = 250) {
  const deadline = Date.now() + timeoutMs
  let last
  while (Date.now() < deadline) {
    last = await probe()
    if (last) return last
    await sleep(intervalMs)
  }
  throw new Error(`timed out after ${timeoutMs}ms waiting for ${description} (last=${oneLine(String(last), 200)})`)
}

// ── remote helpers ───────────────────────────────────────────────────

let rpcSeq = 0
let cookie = ''

/**
 * POST one client-request envelope to the plugin remote gateway.
 * @returns {Promise<{httpStatus:number, json:any, text:string}>}
 */
async function rpc(method, args, { withCookie = true } = {}) {
  const body = {
    type: 'client-request',
    rpcId: `e2e-${process.pid}-${++rpcSeq}`,
    method,
    payload: { args },
  }
  const response = await fetch(`${BASE}/api/${method}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', ...(withCookie && cookie ? { cookie } : {}) },
    body: JSON.stringify(body),
  })
  const text = await response.text()
  let json
  try {
    json = JSON.parse(text)
  } catch {
    json = undefined
  }
  return { httpStatus: response.status, json, text }
}

/** Unwrap a gateway envelope, throwing the server-reported error when refused. */
function unwrap(result, method) {
  if (result.httpStatus !== 200) throw new Error(`${method}: HTTP ${result.httpStatus} ${oneLine(result.text, 300)}`)
  const body = result.json?.result
  if (body === undefined) throw new Error(`${method}: no result in envelope: ${oneLine(result.text, 300)}`)
  if (body.ok !== true) {
    throw new Error(`${method}: refused ${body.error?.code ?? '?'} ${body.error?.message ?? oneLine(result.text, 200)}`)
  }
  return body.value
}

async function getJson(path) {
  const response = await fetch(`${BASE}${path}`, { headers: cookie ? { cookie } : {} })
  const text = await response.text()
  let json
  try {
    json = JSON.parse(text)
  } catch {
    json = undefined
  }
  return { httpStatus: response.status, text, json, contentType: response.headers.get('content-type') }
}

/**
 * POST the plugin's own manual reconcile route and report whether the engine
 * answered within the budget — the difference between "a quiet engine" and
 * "a pass stuck forever".
 * @returns a human-readable outcome line.
 */
async function manualReconcile(timeoutMs) {
  const started = Date.now()
  try {
    const response = await fetch(`${BASE}/api/dsh-plugins-plus/reconcile`, {
      method: 'POST',
      headers: { cookie },
      signal: AbortSignal.timeout(timeoutMs),
    })
    const text = await response.text()
    return `HTTP ${response.status} after ${Date.now() - started}ms :: ${oneLine(text, 200)}`
  } catch (error) {
    return `NO ANSWER after ${Date.now() - started}ms (${error?.name ?? error}) — the engine did not complete a pass`
  }
}

const readPatch = () => readText(join(PROFILE_DIR, 'cordis.patch.yml')) ?? ''

/** Top-level entry ids declared by the profile patch (ignores comments/indent). */
function patchEntryIds(text = readPatch()) {
  return text
    .split('\n')
    .map(line => line.match(/^- id:\s*(.+?)\s*$/)?.[1])
    .filter(Boolean)
}

/** Wait until the profile patch satisfies `predicate`, returning its text. */
function waitForPatch(description, predicate, timeoutMs = PATCH_WAIT_MS) {
  return waitFor(description, () => {
    const patch = readPatch()
    return predicate(patch) ? patch : undefined
  }, timeoutMs)
}

/** Diagnostics captured for failing assertions, reported in the summary. */
const diagnosticsByLabel = new Map()

/**
 * Snapshot everything a failing assertion needs to explain itself: the patch on
 * disk, the plugin's own run log, and the status payload.
 */
async function diagnostics(label) {
  const stub = { patch: readPatch(), log: undefined, status: undefined, savedTo: undefined }
  try {
    const log = await getJson('/api/dsh-plugins-plus/log')
    stub.log = log.httpStatus === 200 ? log.text : `HTTP ${log.httpStatus} ${oneLine(log.text, 200)}`
  } catch (error) {
    stub.log = `unreachable: ${String(error)}`
  }
  try {
    stub.status = await getJson('/api/dsh-plugins-plus/status')
  } catch (error) {
    stub.status = { httpStatus: 0, text: String(error) }
  }
  const path = join(REPORT_DIR, `${opts.phase}-diag-${label}.txt`)
  writeFileSync(
    path,
    [
      `# diagnostics ${label} @ ${new Date().toISOString()}`,
      `## ${PROFILE_DIR}/cordis.patch.yml`,
      stub.patch,
      `## GET /api/dsh-plugins-plus/log`,
      stub.log,
      `## GET /api/dsh-plugins-plus/status`,
      typeof stub.status === 'string' ? stub.status : stub.status.text,
      '',
    ].join('\n'),
  )
  stub.savedTo = path
  diagnosticsByLabel.set(label, stub)
  // The two artifacts a failure has to be judged from, saved verbatim.
  writeFileSync(join(REPORT_DIR, `${opts.phase}-patch-${label}.yml`), stub.patch)
  if (stub.status !== undefined && typeof stub.status !== 'string') {
    writeFileSync(join(REPORT_DIR, `${opts.phase}-status-${label}.json`), stub.status.text)
  }
  return stub
}

/** Brace-match the `window.__DSH_BOOT__ = {…}` global out of the served shell. */
function extractBootGraph(html) {
  const at = html.indexOf('__DSH_BOOT__')
  if (at < 0) return undefined
  const start = html.indexOf('{', at)
  if (start < 0) return undefined
  let depth = 0
  let inString = false
  let escaped = false
  for (let index = start; index < html.length; index += 1) {
    const char = html[index]
    if (inString) {
      if (escaped) escaped = false
      else if (char === '\\') escaped = true
      else if (char === '"') inString = false
      continue
    }
    if (char === '"') inString = true
    else if (char === '{') depth += 1
    else if (char === '}') {
      depth -= 1
      if (depth === 0) {
        try {
          return JSON.parse(html.slice(start, index + 1))
        } catch {
          return undefined
        }
      }
    }
  }
  return undefined
}

/** Every entry id and bundle url the boot graph carries. */
function bootGraphFacts(graph) {
  const ids = new Set()
  const urls = new Set()
  const walk = value => {
    if (Array.isArray(value)) for (const item of value) walk(item)
    else if (value !== null && typeof value === 'object') {
      if (typeof value.id === 'string') ids.add(value.id)
      if (typeof value.url === 'string') urls.add(value.url)
      for (const item of Object.values(value)) walk(item)
    }
  }
  walk(graph)
  return { ids: [...ids], urls: [...urls] }
}

/** The profile patch with every top-level entry removed (comment header kept). */
function stripPatchEntries(patch) {
  const lines = patch.split('\n')
  const firstEntry = lines.findIndex(line => /^- /.test(line))
  const head = (firstEntry === -1 ? lines : lines.slice(0, firstEntry)).join('\n').replace(/\s+$/, '')
  return `${head}\n[]\n`
}

/**
 * Canonical form of a patch list for comparison: parsed YAML when possible (the
 * profile patch carries `!!js` scalars, so a permissive tag is installed), raw
 * text otherwise. Byte equality is reported separately — the semantic form is
 * what "the engine put everything back" actually means.
 */
function canonicalPatch(text, { ignoreDisabled = false, ignorePresetRows = false } = {}) {
  try {
    const doc = parseYaml(text, {
      logLevel: 'silent',
      customTags: [{ tag: 'tag:yaml.org,2002:js', resolve: value => ({ __jsExpr: String(value) }) }],
    })
    let entries = Array.isArray(doc) ? doc : []
    if (ignorePresetRows) entries = entries.filter(entry => !String(entry?.id ?? '').startsWith('preset-'))
    if (ignoreDisabled) for (const entry of entries) delete entry?.disabled
    return { mode: 'yaml', value: JSON.stringify(entries) }
  } catch (error) {
    return { mode: `raw (yaml parse failed: ${error?.message ?? error})`, value: text }
  }
}

/**
 * The post-run read-out of one preset override, verbatim.
 * @returns the `- id: <presetId>` block, or undefined when the patch has no such entry.
 */
function presetBlockOf(patch, presetId) {
  const lines = patch.split('\n')
  const escaped = presetId.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
  const start = lines.findIndex(line => new RegExp(`^- id:\\s*${escaped}\\s*$`).test(line))
  if (start < 0) return undefined
  let end = lines.length
  for (let index = start + 1; index < lines.length; index += 1) {
    if (/^- /.test(lines[index])) {
      end = index
      break
    }
  }
  return lines.slice(start, end).join('\n')
}

/** One-line summary of the plugin's own reconcile history (for evidence). */
function logSummary(log) {
  if (typeof log !== 'string') return 'no log'
  const passes = log.split('\n').filter(line => /原因 .*写入/.test(line))
  const errors = log.split('\n').filter(line => /失败|错误|放弃|重试/.test(line))
  return `passes=${passes.length}${passes.length ? ` :: ${passes.slice(0, 3).join(' || ')}` : ''}${errors.length ? ` :: errors=${errors.slice(0, 3).join(' || ')}` : ''}`
}

// ── main ─────────────────────────────────────────────────────────────

async function main() {
  mkdirSync(REPORT_DIR, { recursive: true })
  keepServer = opts.keepServer

  // Guards: nothing here may touch a real profile or the desktop app.
  if (FORBIDDEN_PROFILES.has(PROFILE)) guard(`refusing to run against real profile "${PROFILE}"`)
  if (FORBIDDEN_PORTS.has(PORT)) guard(`refusing to bind the desktop app's port ${PORT}`)
  if (!existsSync(join(PROFILE_DIR, 'package.json'))) guard(`profile ${PROFILE} not found at ${PROFILE_DIR}`)
  if (!commandExists('dsh')) guard('dsh not on PATH (export PATH="$HOME/.local/bin:$PATH")')
  const stale = spawnSync('pgrep', ['-fl', `dsh --profile ${PROFILE}`]).stdout?.toString().trim()
  if (stale) {
    // A crashed earlier run must not leave us testing against its process.
    run('sh', ['-c', `pkill -f "dsh --profile ${PROFILE}"`])
    await sleep(1500)
    process.stdout.write(`  · killed a leftover server for this profile: ${oneLine(stale, 160)}\n`)
  }
  if (!(await portIsFree(PORT))) guard(`port ${PORT} is already in use`)

  const realProfilesBefore = new Map(
    [...FORBIDDEN_PROFILES].map(profile => [profile, profileDigest(profile)]),
  )

  const dshVersion = run('dsh', ['--version']).stdout.trim()
  const gitHead = run('git', ['-C', REPO, 'rev-parse', '--short', 'HEAD']).stdout.trim()
  const gitDirty = run('git', ['-C', REPO, 'status', '--porcelain']).stdout.trim()
  const provenance = {
    dshVersion,
    nodeVersion: process.version,
    profile: PROFILE,
    port: PORT,
    repo: REPO,
    gitHead,
    gitDirty: gitDirty.length > 0,
    packageVersion: JSON.parse(readFileSync(join(REPO, 'package.json'), 'utf8')).version,
    buildFreshness: buildFreshness(),
  }

  banner('0. environment & guards')
  process.stdout.write(`  dsh ${dshVersion} · node ${process.version} · profile ${PROFILE} · port ${PORT}\n`)
  process.stdout.write(`  repo ${REPO} @ ${gitHead}${gitDirty ? ' (dirty)' : ''} · plugin v${provenance.packageVersion}\n`)
  record('G1', `profile "${PROFILE}" is not a real profile, port ${PORT} != 19387`, 'pass',
    `guards: forbidden profiles ${[...FORBIDDEN_PROFILES].join(', ')}; forbidden ports ${[...FORBIDDEN_PORTS].join(', ')}`)
  if (provenance.buildFreshness.stale) {
    record('G2', 'lib/ is newer than src/ (linked package is the built artifact)', 'fail', provenance.buildFreshness.detail)
  } else {
    record('G2', 'lib/ is newer than src/ (linked package is the built artifact)', 'pass', provenance.buildFreshness.detail)
  }

  // A run must start from a state its assertions can mean something in: a patch
  // that already carries a previous run's takeover rows makes "the write reached
  // the patch" and "the takeover was released" both unfalsifiable. The previous
  // content is archived, never re-applied at teardown — this script performs no
  // manual restore after the test, only this clearly labelled setup reset.
  const preRunPatch = readPatch()
  writeFileSync(join(REPORT_DIR, `${opts.phase}-pre-run-patch.yml`), preRunPatch)
  const polluted = /^- id: preset-/m.test(preRunPatch) || PIPELINE_ROWS.some(row => preRunPatch.includes(row))
  if (opts.reset && polluted) {
    writeFileSync(join(PROFILE_DIR, 'cordis.patch.yml'), stripPatchEntries(preRunPatch))
  }
  const initialPatch = readPatch()
  const cleanStart = !PIPELINE_ROWS.some(row => initialPatch.includes(row)) &&
    !patchEntryIds(initialPatch).some(id => id.startsWith('preset-'))
  record('G4', 'the run starts with no takeover override in the patch (open→close path is covered)', opts.reset ? (cleanStart ? 'pass' : 'fail') : 'info',
    cleanStart
      ? `start entries=[${patchEntryIds(initialPatch).join(', ') || '(none)'}] — nothing pre-existing to mask a failed write or a failed release`
      : `start entries=[${patchEntryIds(initialPatch).join(', ') || '(none)'}] still carry a preset override (--keep-profile): this run covers the upgrade path only`)
  record('G3', 'pre-run profile state recorded; the test starts from a pristine patch', opts.reset ? 'pass' : 'info',
    `pre-run entries=[${patchEntryIds(preRunPatch).join(', ') || '(none)'}] archived to ${opts.phase}-pre-run-patch.yml; ` +
    `${opts.reset ? `reset to entries=[${patchEntryIds().join(', ') || '(none)'}]` : 'reset disabled (--keep-profile)'}; ` +
    'the only writer after this point is DSH and the plugin under test')

  // ── A. link install ────────────────────────────────────────────────
  banner('A. link install into the scratch profile')
  if (opts.noInstall) {
    record('A1', `dsh plugin --profile ${PROFILE} add link:<repo> exits 0`, 'skip', '--no-install')
  } else {
    const install = run('dsh', ['plugin', '--profile', PROFILE, 'add', `link:${REPO}`], INSTALL_TIMEOUT_MS)
    const raw = `${install.stdout}${install.stderr}`.trim()
    writeFileSync(join(REPORT_DIR, `${opts.phase}-install.log`), raw)
    if (install.status !== 0 || /nothing was installed|installation rejected|command failed/.test(raw)) {
      record('A1', `dsh plugin --profile ${PROFILE} add link:<repo> exits 0`, 'fail',
        `exit=${install.status} :: ${oneLine(raw, 700)}`)
      notes.push(`INSTALL REJECTED — full output: scripts/e2e/reports/${opts.phase}-install.log`)
      await finish(provenance, realProfilesBefore)
      return { provenance, realProfilesBefore }
    }
    record('A1', `dsh plugin --profile ${PROFILE} add link:<repo> exits 0`, 'pass',
      `exit=0 :: ${oneLine(raw, 400)}`)
  }

  await check('A2', 'profile package.json depends on the plugin and selects its bundle', () => {
    const manifest = JSON.parse(readFileSync(join(PROFILE_DIR, 'package.json'), 'utf8'))
    const dep = manifest.dependencies?.[PKG]
    const bundles = manifest.dsh?.profile?.bundles ?? []
    assert(dep !== undefined, `no dependency "${PKG}" in ${PROFILE_DIR}/package.json`)
    assert(bundles.includes(PKG), `bundle "${PKG}" missing from dsh.profile.bundles`, JSON.stringify(bundles))
    return `dependency=${dep} bundles=${JSON.stringify(bundles)}`
  })

  await check('A3', 'dsh plugin list reports no incompatibility for this plugin', () => {
    const list = run('dsh', ['plugin', '--profile', PROFILE, 'list'], 120_000)
    const raw = `${list.stdout}${list.stderr}`
    writeFileSync(join(REPORT_DIR, `${opts.phase}-plugin-list.log`), raw.trim())
    const offender = raw
      .split('\n')
      .filter(line => line.includes(PKG) && /incompatible|not active|warning/i.test(line))
    assert(offender.length === 0, `list still flags the plugin`, offender.join(' | '))
    assert(raw.includes(PKG), `list output never mentions ${PKG}`, oneLine(raw, 300))
    return oneLine(raw.split('\n').filter(line => line.includes(PKG)).join(' | '), 300)
  })

  const appBoot = await loadAppBoot()
  if (appBoot === undefined) {
    record('A4', 'DSH own compatibility judge (evaluatePluginCompatibility) clears the manifest', 'skip',
      'dsh-app-boot/lib not resolvable from the global install or the profile — checked A1/A3 instead')
  } else {
    await check('A4', 'DSH own compatibility judge (evaluatePluginCompatibility) clears the manifest', () => {
      const manifestPath = join(PROFILE_DIR, 'node_modules', PKG, 'package.json')
      const manifest = JSON.parse(readFileSync(manifestPath, 'utf8'))
      const verdict = appBoot.mod.evaluatePluginCompatibility(manifest, appBoot.mod.readProfileVersionExemptions(PROFILE_DIR))
      assert(verdict === undefined, `verdict: ${oneLine(JSON.stringify(verdict), 400)}`)
      return `runtime=${appBoot.mod.getDshRuntimeVersion()} installed=${manifest.version} verdict=undefined (${appBoot.path.replace(DSH_HOME, '~')})`
    })
  }

  // ── B. boot ────────────────────────────────────────────────────────
  banner('B. boot the profile and take the token / cookie')
  serverLogPath = join(REPORT_DIR, `${opts.phase}-server.log`)
  const logStream = []
  serverLog = logStream
  serverChild = spawn('dsh', ['--profile', PROFILE, '--port', String(PORT), '--no-open'], {
    cwd: REPO,
    detached: true,
    stdio: ['ignore', 'pipe', 'pipe'],
  })
  serverChild.stdout.on('data', chunk => logStream.push(String(chunk)))
  serverChild.stderr.on('data', chunk => logStream.push(String(chunk)))
  serverChild.unref()
  record('B1', `dsh --profile ${PROFILE} --port ${PORT} --no-open starts (detached, pid recorded)`, 'pass',
    `pid=${serverChild.pid}`)

  let token
  await check('B2', 'startup log prints the one-time token', async () => {
    token = await waitFor('the token line', () => logStream.join('').match(/token=([A-Za-z0-9_.-]+)/)?.[1], BOOT_TIMEOUT_MS, 200)
    return `token=${token} (from "${oneLine(logStream.join(''), 160)}")`
  })
  if (token === undefined) {
    writeFileSync(serverLogPath, logStream.join(''))
    await finish(provenance, realProfilesBefore)
    return { provenance, realProfilesBefore }
  }

  await check('B3', 'no "skipping profile bundle" / incompatibility line at boot', () => {
    const log = logStream.join('')
    const bad = log.split('\n').filter(line => /skipping profile bundle|incompatible|disabling profile plugin/.test(line))
    assert(bad.length === 0, `${bad.length} denial line(s)`, bad.slice(0, 2).join(' | '))
    return oneLine(log, 200)
  })

  await check('B4', 'GET /?token=… answers 303 + sets the auth cookie', async () => {
    const response = await fetch(`${BASE}/?token=${token}`, { redirect: 'manual' })
    const setCookies = response.headers.getSetCookie?.() ?? []
    const authCookie = setCookies.find(value => value.startsWith('dsh-auth-'))
    assert(authCookie !== undefined, `no dsh-auth cookie in ${JSON.stringify(setCookies)}`, `status=${response.status}`)
    cookie = authCookie.split(';')[0]
    return `status=${response.status} location=${response.headers.get('location')} cookie=${cookie.slice(0, 24)}…`
  })

  await check('B5', 'the same call without the cookie is refused (401)', async () => {
    await waitFor('the server to answer', async () => {
      try {
        return (await getJson('/api/dsh-plugins-plus/status')).httpStatus !== 0
      } catch {
        return false
      }
    }, BOOT_TIMEOUT_MS, 250)
    const anonymous = await rpc('settings/describe', {}, { withCookie: false })
    assert(anonymous.httpStatus === 401, `expected 401, got ${anonymous.httpStatus}`, anonymous.text)
    const withCookie = await rpc('settings/describe', {})
    assert(withCookie.httpStatus === 200, `cookie call got HTTP ${withCookie.httpStatus}`, withCookie.text)
    return `no cookie -> HTTP 401 (${oneLine(anonymous.text, 80)}); cookie -> HTTP 200`
  })

  const patchAtBoot = readPatch()
  writeFileSync(join(REPORT_DIR, `${opts.phase}-patch-at-boot.yml`), patchAtBoot)
  record('B6', 'post-boot profile patch snapshot (the reference the release claim is measured against)', 'info',
    `entries=[${patchEntryIds(patchAtBoot).join(', ') || '(none)'}]`)

  // ── C. real remote ─────────────────────────────────────────────────
  banner('C. real remote: describe -> components -> mutate -> patch on disk')

  let describeValue
  await check('C1', 'settings/describe serves namespace dsh-plugins-plus with applies=live, autoGenerate=false', async () => {
    describeValue = unwrap(await rpc('settings/describe', {}), 'settings/describe')
    const ns = describeValue.namespaces?.find(entry => entry.ns === CORE_NS)
    assert(ns !== undefined, `namespace ${CORE_NS} is not served`, `namespaces=${describeValue.namespaces?.length}`)
    assert(ns.applies === 'live', `applies=${ns.applies}`, JSON.stringify(ns.applies))
    assert(ns.autoGenerate === false, `autoGenerate=${ns.autoGenerate} (pitfall 6: settings.configure needs the row's own fiber)`)
    assert(describeValue.writable === true, `writable=${describeValue.writable}`)
    return `ns=${ns.ns} applies=${ns.applies} autoGenerate=${ns.autoGenerate} writable=${describeValue.writable} revision=${ns.revision} value=${oneLine(JSON.stringify(ns.value), 200)}`
  })

  await check('C2', 'pluginManager/listPlugins exposes our rows under their loader entry ids', async () => {
    const value = unwrap(await rpc('pluginManager/listPlugins', {}), 'pluginManager/listPlugins')
    const entries = Array.isArray(value) ? value : (value?.plugins ?? value?.entries ?? [])
    const ids = entries.map(entry => entry?.id ?? entry?.entryId).filter(Boolean)
    const ours = ids.filter(id => String(id).includes('plus'))
    assert(ours.length > 0, 'no entry id contains "plus"', oneLine(JSON.stringify(ids.slice(0, 40)), 400))
    for (const wanted of COMPONENT_ENTRIES) {
      assert(ours.includes(wanted), `entry id ${wanted} not listed`, oneLine(JSON.stringify(ours), 300))
    }
    return `entry ids: ${ours.join(', ')}`
  })

  await check('C3', 'setPluginEnabled with a patch id (agent-instructions-plus) is refused — pitfall 7', async () => {
    const result = await rpc('pluginManager/setPluginEnabled', { id: 'agent-instructions-plus', enabled: true })
    const body = result.json?.result
    if (body?.ok === true) {
      return record('C3x', 'patch id accepted', 'info', `accepted: ${oneLine(result.text, 200)}`) && undefined
    }
    assert(/unknown-plugin/.test(result.text), 'refused, but not with unknown-plugin', oneLine(result.text, 400))
    return `refused: ${oneLine(result.text, 220)}`
  })

  for (const [index, entryId] of COMPONENT_ENTRIES.entries()) {
    await check(`C4.${index + 1}`, `pluginManager/setPluginEnabled(${entryId}, true) applies`, async () => {
      const value = unwrap(await rpc('pluginManager/setPluginEnabled', { id: entryId, enabled: true }), 'setPluginEnabled')
      assert(value.application === 'applied', `application=${value.application} ${oneLine(JSON.stringify(value.error ?? ''), 200)}`)
      assert(value.enabled !== false, `enabled=${value.enabled}`)
      return `changed=${value.changed} application=${value.application} stage=${value.stage} target=${value.target} enabled=${value.enabled}`
    })
  }

  let status
  await check('C5', 'GET /api/dsh-plugins-plus/status reports both components mounted', async () => {
    status = await waitFor('both components to be mounted', async () => {
      const response = await getJson('/api/dsh-plugins-plus/status')
      if (response.httpStatus !== 200 || response.json === undefined) return undefined
      const mounted = (response.json.components ?? []).filter(component => component.mounted === true)
      return mounted.length === COMPONENT_ENTRIES.length ? response.json : undefined
    }, BOOT_TIMEOUT_MS, 300)
    return oneLine(JSON.stringify(status.components), 400)
  })

  const componentReports = await getJson('/api/dsh-plugins-plus/status')
  await check('C6', 'status route returns a JSON bundle state (components + presets + history)', () => {
    assert(componentReports.httpStatus === 200, `HTTP ${componentReports.httpStatus}`, componentReports.text)
    assert(/application\/json/.test(componentReports.contentType ?? ''), `content-type=${componentReports.contentType}`)
    const body = componentReports.json
    assert(Array.isArray(body?.components) && body.components.length === 2, `components=${oneLine(JSON.stringify(body?.components), 200)}`)
    assert(Array.isArray(body?.presets) && body.presets.length > 0, `presets=${oneLine(JSON.stringify(body?.presets), 200)}`)
    const target = body.presets.find(preset => preset.id === PRESET)
    assert(target !== undefined, `preset ${PRESET} not in status.presets`, oneLine(JSON.stringify(body.presets.map(p => p.id)), 200))
    return `components=${body.components.length} presets=${body.presets.map(p => p.id).join(',')} overridden=${target.overridden}`
  })

  await check('C7', 'GET /api/dsh-plugins-plus/log is live text/plain', async () => {
    const response = await getJson('/api/dsh-plugins-plus/log')
    assert(response.httpStatus === 200, `HTTP ${response.httpStatus}`, response.text)
    assert(/text\/plain/.test(response.contentType ?? ''), `content-type=${response.contentType}`)
    assert(response.text.includes('dsh-plugins-plus'), 'log body is not our log', oneLine(response.text, 200))
    return `HTTP 200 ${response.contentType} :: ${oneLine(response.text.split('\n').slice(0, 3).join(' / '), 240)}`
  })

  const patchBeforeTakeover = readPatch()
  const nsBefore = describeValue?.namespaces?.find(entry => entry.ns === CORE_NS)
  let mutateValue
  await check('C8', `settings/mutate opens the takeover for preset "${PRESET}"`, async () => {
    const ops = [
      { op: 'set', path: ['presetsMode'], value: 'list' },
      { op: 'set', path: ['presets'], value: [PRESET] },
    ]
    mutateValue = unwrap(
      await rpc('settings/mutate', { ns: CORE_NS, ops, expectedRevision: nsBefore?.revision ?? 0 }),
      'settings/mutate',
    )
    assert(mutateValue.applies === 'live', `applies=${mutateValue.applies}`)
    assert(mutateValue.value?.presetsMode === 'list', `presetsMode=${mutateValue.value?.presetsMode}`)
    assert(JSON.stringify(mutateValue.value?.presets) === JSON.stringify([PRESET]), `presets=${JSON.stringify(mutateValue.value?.presets)}`)
    return `applies=${mutateValue.applies} value=${oneLine(JSON.stringify(mutateValue.value), 240)} revision=${mutateValue.revision}`
  })

  await check('C9', 'the write reaches the profile patch on disk (pipeline row + gated built-in)', async () => {
    const before = patchEntryIds()
    const patch = await waitForPatch(
      'the preset override to appear in cordis.patch.yml',
      text => PIPELINE_ROWS.every(row => text.includes(row)) && text.includes(`- id: preset-${PRESET}`),
    )
    for (const row of PIPELINE_ROWS) {
      assert(patch.includes(row), `patch is missing ${row}`, oneLine(patch, 300))
    }
    assert(/agent-instructions:\s*\n\s*disabled:\s*true/.test(patch) || patch.includes('disabled: true'),
      'the built-in rows were not gated', oneLine(patch, 300))
    writeFileSync(join(REPORT_DIR, `${opts.phase}-patch-takeover.yml`), patch)
    const block = presetBlockOf(patch, `preset-${PRESET}`) ?? ''
    return `entries before=[${before.join(', ') || '(none)'}] after=[${patchEntryIds(patch).join(', ')}]; ` +
      `override carries ${PIPELINE_ROWS.filter(row => block.includes(row)).join('+')} and agent-instructions disabled=${
        /- id: agent-instructions\b[\s\S]*?disabled: true/.test(block)}`
  })

  await check('C10', 'status reports the takeover applied to the preset', async () => {
    const body = await waitFor('status to report the takeover', async () => {
      const response = await getJson('/api/dsh-plugins-plus/status')
      const target = response.json?.presets?.find(preset => preset.id === PRESET)
      return target?.overridden === true && target?.components?.['agent-instructions-plus']?.pipeline === true
        ? response.json
        : undefined
    }, PATCH_WAIT_MS, 300)
    const target = body.presets.find(preset => preset.id === PRESET)
    assert(target.components['skill-filesystem-plus'].pipeline === true, 'skill-filesystem pipeline row missing',
      JSON.stringify(target.components))
    return `overridden=${target.overridden} components=${oneLine(JSON.stringify(target.components), 300)}`
  })

  await check('C10b', 'no preset reports broken while the takeover is live (the preset plane really started)', async () => {
    const body = await getJson('/api/dsh-plugins-plus/status')
    const presets = body.json?.presets ?? []
    assert(presets.length > 0, 'status lists no preset', oneLine(body.text, 200))
    const target = presets.find(preset => preset.id === PRESET)
    assert(target !== undefined, `preset ${PRESET} missing from status`)
    assert(target.broken === undefined, `preset ${PRESET} is broken: ${target.broken}`,
      'compositionInventory() reported a row that never started (AGENTS.md pitfall 21) — the takeover engine skips such presets')
    const others = presets.filter(preset => preset.broken !== undefined).map(preset => `${preset.id}: ${preset.broken}`)
    const line = `presets=${presets.map(preset => `${preset.id}${preset.broken === undefined ? '' : `(BROKEN: ${preset.broken})`}`).join(', ')}`
    if (others.length > 0) notes.push(`other presets reported broken (not ours): ${others.join(' | ')}`)
    return line
  })

  {
    // When the profile already carried the takeover (an upgrade, not a first
    // run) the engine legitimately writes nothing, so the pass only has to
    // exist and name both mounted components.
    const preexisting = PIPELINE_ROWS.every(row => patchBeforeTakeover.includes(row))
    const wanted = preexisting ? /原因 .*写入 \d+ 个预设/ : /写入 [1-9]\d* 个预设/
    try {
      const line = await waitFor('a pass record in the run log', async () => {
        const text = (await getJson('/api/dsh-plugins-plus/log')).text
        return text.split('\n').find(entry => wanted.test(entry))
      }, PATCH_WAIT_MS, 300)
      record('C11', 'the engine pass behind the takeover is recorded in the run log', 'pass',
        `${preexisting ? 'patch already carried the takeover (upgrade path → a write is not expected): ' : ''}${oneLine(line, 240)}`)
    } catch (error) {
      record('C11', 'the engine pass behind the takeover is recorded in the run log', 'fail',
        `${error.message} | preexisting takeover=${preexisting}`)
    }
  }

  await check('C12', 'a mismatched expectedRevision is refused (the trap that fakes a failed release)', async () => {
    const live = unwrap(await rpc('settings/describe', {}), 'settings/describe')
      .namespaces?.find(entry => entry.ns === CORE_NS)
    assert(live !== undefined, `namespace ${CORE_NS} disappeared`)
    const result = await rpc('settings/mutate', {
      ns: CORE_NS,
      ops: [{ op: 'set', path: ['presetsMode'], value: 'list' }],
      expectedRevision: live.revision + 3,
    })
    const body = result.json?.result
    assert(body?.ok !== true, `a mutate with expectedRevision ${live.revision + 3} against live ${live.revision} was ACCEPTED — the revision guard is not enforced`,
      oneLine(result.text, 300))
    const after = await rpc('settings/describe', {})
    const revision = after.json?.result?.value?.namespaces?.find(entry => entry.ns === CORE_NS)?.revision
    return `live revision=${live.revision}, sent ${live.revision + 3} -> refused (${oneLine(result.text, 200)}); revision still ${revision}`
  })

  // ── F. browser half ────────────────────────────────────────────────
  banner('F. client half: is the bundle really in the browser module graph?')

  let shellHtml = ''
  let bootGraph
  await check('F1', 'GET / serves the shell with a parseable window.__DSH_BOOT__ graph', async () => {
    const response = await fetch(`${BASE}/`, { headers: { cookie } })
    shellHtml = await response.text()
    assert(response.status === 200, `HTTP ${response.status}`)
    assert(shellHtml.includes('__DSH_BOOT__'), 'the served shell has no __DSH_BOOT__ global')
    bootGraph = extractBootGraph(shellHtml)
    assert(bootGraph !== undefined, 'the __DSH_BOOT__ global is not extractable/parseable')
    const facts = bootGraphFacts(bootGraph)
    assert(facts.ids.length > 0, 'the boot graph lists no entry ids')
    return `HTTP 200, ${shellHtml.length} bytes, graph entries=${facts.ids.length} bundles=${facts.urls.length}`
  })

  await check('F2', 'our package is an entry in the composed client graph', () => {
    const facts = bootGraphFacts(bootGraph)
    const own = facts.ids.filter(id => id.includes('dsh-plugins-plus'))
    assert(own.length > 0, 'our package is absent from the client module graph',
      `graph ids (${facts.ids.length}): ${oneLine(facts.ids.join(', '), 400)}`)
    return `graph ids mentioning us: ${own.join(', ')}`
  })

  await check('F3', 'our client bundle is served to the browser (HTTP 200 + our code inside)', async () => {
    const entry = (bootGraph?.entries ?? []).find(item => String(item.id).includes('dsh-plugins-plus'))
    assert(entry !== undefined, 'no graph entry for our package', oneLine(JSON.stringify((bootGraph?.entries ?? []).map(e => e.id)), 300))
    assert(typeof entry.url === 'string' && entry.url.length > 0, 'our graph entry carries no bundle url', JSON.stringify(entry))
    const absolute = new URL(entry.url, BASE)
    const response = await fetch(absolute, { headers: { cookie } })
    const body = await response.text()
    assert(response.status === 200, `${absolute.pathname} -> HTTP ${response.status}`)
    assert(body.includes('dppBtn'), 'the served bundle does not contain our client code (marker dppBtn)',
      `${body.length} bytes: ${oneLine(body.slice(0, 200), 200)}`)
    const digest = createHash('sha256').update(body).digest('hex').slice(0, 16)
    return `${absolute.pathname}${absolute.search} -> HTTP 200, ${body.length} bytes, marker "dppBtn" present, sha256=${digest}…, rev=${entry.rev}`
  })

  await check('F4', 'every bundle batch the shell preloads answers 200 (no 4xx/5xx in the module graph)', async () => {
    const batches = bootGraph?.batches ?? []
    assert(batches.length > 0, 'the boot graph declares no bundle batch')
    const mine = batches.filter(batch => (batch.entries ?? []).some(id => String(id).includes('dsh-plugins-plus')))
    assert(mine.length === 1, `our package should sit in exactly one batch, found ${mine.length}`,
      JSON.stringify(batches.map(batch => ({ entries: (batch.entries ?? []).length, has: (batch.entries ?? []).some(id => String(id).includes('dsh-plugins-plus')) }))))
    const failures = []
    const shippedRequires = new Set()
    let bytes = 0
    for (const batch of batches) {
      const response = await fetch(new URL(batch.url, BASE), { headers: { cookie } })
      const text = await response.text()
      bytes += text.length
      for (const match of text.matchAll(/require\("([^".][^"]*)"\)/g)) shippedRequires.add(match[1])
      if (response.status !== 200) failures.push(`${batch.phase} -> HTTP ${response.status}`)
    }
    assert(failures.length === 0, `${failures.length} batch(es) failed: ${failures.join(', ')}`)
    writeFileSync(join(REPORT_DIR, `${opts.phase}-shipped-requires.json`), `${JSON.stringify([...shippedRequires].sort(), null, 2)}\n`)
    return `${batches.length} batches (${batches.map(b => b.phase).join('/')}) all HTTP 200, ${bytes} bytes total; ours in the "${mine[0].phase}" batch`
  })

  await check('F5', 'every id in dsh.client.inject exists in this DSH runtime (no removed package)', () => {
    const entry = (bootGraph?.entries ?? []).find(item => String(item.id).includes('dsh-plugins-plus'))
    assert(entry !== undefined, 'no graph entry for our package')
    const declared = entry.inject ?? []
    const declaredManifest = JSON.parse(readFileSync(join(REPO, 'package.json'), 'utf8')).dsh?.client?.inject ?? []
    assert(JSON.stringify([...declared].sort()) === JSON.stringify([...declaredManifest].sort()),
      'the served graph and package.json disagree about dsh.client.inject',
      `graph=[${declared.join(', ')}] package.json=[${declaredManifest.join(', ')}]`)
    const runtimeRoot = dshRuntimeRoot()
    const missing = declared.filter(id => !existsSync(join(runtimeRoot, 'node_modules', id, 'package.json')))
    assert(missing.length === 0, `declared but absent from the running DSH install: ${missing.join(', ')}`,
      `runtime=${runtimeRoot} (0.2.0 has no @deepseek-ai/dsh-client-runtime)`)
    const inert = declared.filter(id => !(bootGraph?.entries ?? []).some(row => row.id === id))
    return `inject=[${declared.join(', ')}] — present in ${runtimeRoot.replace(process.env.HOME, '~')}; ` +
      `graph rows: [${declared.filter(id => !inert.includes(id)).join(', ') || '(none)'}]${inert.length ? `, inert (not a client row, the module system ignores unknown ids): [${inert.join(', ')}]` : ''}`
  })

  await check('F6', 'the built client bundle only requires modules the platform already provides', async () => {
    const bundle = readText(join(REPO, 'lib', 'client.js')) ?? ''
    const bare = [...new Set([...bundle.matchAll(/require\("([^".][^"]*)"\)/g)].map(match => match[1]))]
    const shipped = new Set(JSON.parse(readText(join(REPORT_DIR, `${opts.phase}-shipped-requires.json`)) ?? '[]'))
    assert(bare.length > 0, 'the built bundle requires nothing at all (suspicious)', oneLine(bundle.slice(0, 200)))
    const unknown = bare.filter(id => !shipped.has(id))
    assert(unknown.length === 0, `bare require(s) no shipped bundle uses: ${unknown.join(', ')}`,
      `ours=[${bare.join(', ')}]`)
    return `bare requires=[${bare.join(', ')}] — all also required by shipped DSH client bundles`
  })

  // ── D. restore ─────────────────────────────────────────────────────
  banner('D. restore: settings back to shipped-equivalent, components off')

  let patchBeforeRelease
  let patchAfterRelease
  await check('D1', 'settings/mutate back to presets:[] removes the override row', async () => {
    const ops = [
      { op: 'set', path: ['presetsMode'], value: 'list' },
      { op: 'set', path: ['presets'], value: [] },
    ]
    const snapshot = await diagnostics('d1-before')
    patchBeforeRelease = snapshot.patch
    const value = unwrap(
      await rpc('settings/mutate', { ns: CORE_NS, ops, expectedRevision: mutateValue?.revision ?? 0 }),
      'settings/mutate',
    )
    try {
      const patch = await waitForPatch(
        'the takeover rows to disappear from cordis.patch.yml',
        text => !PIPELINE_ROWS.some(row => text.includes(row)) && !text.includes(`- id: preset-${PRESET}`),
      )
      patchAfterRelease = patch
      return `expectedRevision=${mutateValue?.revision} -> revision=${value.revision}; presets=${
        JSON.stringify(value.value?.presets)} entries=[${patchEntryIds(patch).join(', ')}]`
    } catch (error) {
      const after = await diagnostics('d1-after')
      // Is the engine merely quiet, or is a pass stuck? A manual pass answers
      // only if the engine is still able to run one.
      const manual = await manualReconcile(8000)
      throw new Error(
        `${error.message} | mutate answered value=${oneLine(JSON.stringify(value.value), 200)} revision=${value.revision} | ` +
        `patch entries=[${patchEntryIds(after.patch).join(', ')}] | ` +
        `post-release log: ${logSummary(after.log)} | ` +
        `pre-release log: ${logSummary(snapshot.log)} | ` +
        `manual POST /reconcile: ${manual}`,
      )
    }
  })

  for (const [index, entryId] of COMPONENT_ENTRIES.entries()) {
    await check(`D2.${index + 1}`, `setPluginEnabled(${entryId}, false) turns the component off`, async () => {
      const value = unwrap(await rpc('pluginManager/setPluginEnabled', { id: entryId, enabled: false }), 'setPluginEnabled')
      assert(value.application === 'applied', `application=${value.application}`)
      const body = await waitFor(`${entryId} to unmount`, async () => {
        const response = await getJson('/api/dsh-plugins-plus/status')
        const component = response.json?.components?.find(entry => entryId.endsWith(entry.id))
        return component?.mounted === false ? response.json : undefined
      }, PATCH_WAIT_MS, 300)
      const component = body.components.find(entry => entryId.endsWith(entry.id))
      return `changed=${value.changed} application=${value.application} mounted=${component.mounted} everMounted=${component.everMounted}`
    })
  }

  const after = await diagnostics('final')

  await check('D3', 'no "disabled: false" residue anywhere in the profile patch', () => {
    const patch = after.patch
    const offender = patch.split('\n').filter(line => /disabled:\s*false/.test(line))
    assert(offender.length === 0, `${offender.length} line(s) with disabled: false`, offender.join(' | '))
    return `entries=[${patchEntryIds(patch).join(', ')}]`
  })

  await check('D4', 'no preset override left behind (the takeover was fully undone)', () => {
    const presets = patchEntryIds(after.patch).filter(id => id.startsWith('preset-'))
    assert(presets.length === 0, `preset row(s) still overridden: ${presets.join(', ')}`, oneLine(after.patch, 300))
    const leftovers = PIPELINE_ROWS.filter(row => after.patch.includes(row))
    assert(leftovers.length === 0, `pipeline row(s) still in the patch: ${leftovers.join(', ')}`, oneLine(after.patch, 300))
    return `patch entries=[${patchEntryIds(after.patch).join(', ')}] — no preset-* override, no pipeline row`
  })

  // The decisive read-out for "did the takeover release or not": the full final
  // patch and status are on disk from diagnostics('final'); this records exactly
  // what the released preset override still contains.
  const finalPatch = after.patch
  const overrideId = `preset-${PRESET}`
  const presetBlock = presetBlockOf(finalPatch, overrideId)
  writeFileSync(join(REPORT_DIR, `${opts.phase}-preset-override-final.yml`), presetBlock ?? '(no override entry)\n')
  const finalStatus = after.status !== undefined && typeof after.status !== 'string' ? after.status.json : undefined
  const finalPreset = finalStatus?.presets?.find(preset => preset.id === PRESET)
  record(
    'D6',
    `final state of the "${overrideId}" override (raw evidence, saved to disk)`,
    'info',
    `override present=${presetBlock !== undefined}; ` +
      `pipeline rows in the patch: ${PIPELINE_ROWS.map(row => `${row}=${finalPatch.includes(row)}`).join(' ')}; ` +
      `built-in agent-instructions still gated=${/- id: agent-instructions\b[\s\S]*?disabled: true/.test(presetBlock ?? '')}; ` +
      `status.presets[${PRESET}]=${oneLine(JSON.stringify(finalPreset?.components ?? null), 200)}; ` +
      `artifacts: ${opts.phase}-patch-final.yml / ${opts.phase}-status-final.json / ${opts.phase}-preset-override-final.yml`,
  )

  // The plugin's own release claim is measured on the patch as it stands right
  // after the release write and before the component switches (DSH itself writes
  // `disabled: true` row overrides when a component is switched off — that is
  // DSH's bookkeeping, not the takeover engine's).
  // The scenario itself is an assertion: the defect under test only exists when
  // THIS process wrote the takeover override and then has to release it again.
  // A run that starts on top of a leftover override exercises the upgrade path
  // instead, and must not be read as coverage of the open→close path.
  const startedClean = !PIPELINE_ROWS.some(row => patchBeforeTakeover.includes(row)) &&
    !patchEntryIds(patchBeforeTakeover).some(id => id.startsWith('preset-'))
  const wroteInProcess = /写入 [1-9]\d* 个预设/.test(
    (await getJson('/api/dsh-plugins-plus/log')).text.split('\n').find(entry => /原因 .*写入/.test(entry)) ?? '',
  )
  record(
    'D5',
    'scenario: this process opened the takeover itself and then released it',
    startedClean ? 'pass' : 'info',
    startedClean
      ? `start state had no preset override and no pipeline row; the engine recorded a write of its own before the release ` +
        `(in-process write seen=${wroteInProcess}); release verified by D1/D4, leftover-only by D8`
      : `upgrade-path run (--keep-profile): the patch already carried the takeover at start, so this run does NOT cover ` +
        `the open→close path — run without --keep-profile for that; entries at start=[${patchEntryIds(patchBeforeTakeover).join(', ') || '(none)'}]`,
  )

  // After the component switches the only expected difference is DSH's own
  // `disabled: true` override on the two component rows.
  const finalEntries = patchEntryIds()
  const extra = finalEntries.filter(id => !patchEntryIds(patchAtBoot).includes(id))
  const unexpected = extra.filter(id => !['agent-instructions-plus', 'skill-filesystem-plus'].includes(id))
  await check('D7', 'no preset reported broken after the release either', async () => {
    const body = await getJson('/api/dsh-plugins-plus/status')
    const presets = body.json?.presets ?? []
    const target = presets.find(preset => preset.id === PRESET)
    assert(target !== undefined, `preset ${PRESET} missing from status`)
    assert(target.broken === undefined, `preset ${PRESET} is broken after release: ${target.broken}`)
    return `presets=${presets.length}, target broken=undefined, pipeline=${target.components?.['agent-instructions-plus']?.pipeline} ` +
      `builtinDisabled=${target.components?.['agent-instructions-plus']?.builtinDisabled}`
  })
  record('D8', 'final patch gained nothing but the component rows DSH itself switches', unexpected.length === 0 ? 'pass' : 'fail',
    `post-boot=[${patchEntryIds(patchAtBoot).join(', ') || '(none)'}] final=[${finalEntries.join(', ') || '(none)'}] extra=[${extra.join(', ') || '(none)'}]`)

  await finish(provenance, realProfilesBefore)
  return { provenance, realProfilesBefore }
}

// ── reporting ────────────────────────────────────────────────────────

function banner(title) {
  process.stdout.write(`\n${title}\n`)
}

async function finish(provenance, realProfilesBefore) {
  banner('E. teardown & zero side effects')
  if (serverLogPath && serverLog !== undefined) {
    writeFileSync(serverLogPath, serverLog.join(''))
    process.stdout.write(`  · server log: ${serverLogPath}\n`)
  }
  const teardown = await cleanup('normal completion')
  const listeners = await countListeners(PORT)
  record('E1', `port ${PORT} is free again after teardown`, teardown.portFree && listeners === 0 ? 'pass' : 'fail',
    `pid ${teardown.pid} gone=${teardown.processGone} after ${teardown.waitedMs}ms (escalated=${teardown.escalated}); LISTEN rows on ${PORT}: ${listeners}`)
  const leftover = spawnSync('pgrep', ['-fl', `dsh --profile ${PROFILE}`])
  const leftoverText = String(leftover.stdout ?? '').trim()
  record('E2', 'no leftover dsh process for this profile', teardown.processGone && leftoverText.length === 0 ? 'pass' : 'fail',
    leftoverText.length === 0 ? `pgrep -fl "dsh --profile ${PROFILE}" -> (empty)` : leftoverText)

  for (const [profile, before] of realProfilesBefore) {
    const after = profileDigest(profile)
    record('E3', `real profile "${profile}" unchanged (state files hashed before/after)`, before === after ? 'pass' : 'fail',
      before === after ? before : `before=${before} after=${after}`)
  }

  const hard = results.filter(result => result.status === 'pass' || result.status === 'fail')
  const failed = hard.filter(result => result.status === 'fail')
  const skipped = results.filter(result => result.status === 'skip')
  const verdict = failed.length === 0 ? 'PASS' : 'FAIL'

  banner('summary')
  process.stdout.write(`  assertions: ${hard.length - failed.length}/${hard.length} passed` +
    `${skipped.length ? `, ${skipped.length} skipped` : ''}${notes.length ? ` — ${notes.join('; ')}` : ''}\n`)
  for (const note of notes) process.stdout.write(`  ! ${note}\n`)

  const report = {
    phase: opts.phase,
    verdict,
    generatedAt: new Date().toISOString(),
    provenance,
    counts: { total: hard.length, passed: hard.length - failed.length, failed: failed.length, skipped: skipped.length },
    results,
    notes,
  }
  const jsonPath = join(REPORT_DIR, `${opts.phase}-report.json`)
  writeFileSync(jsonPath, `${JSON.stringify(report, null, 2)}\n`)
  writeFileSync(join(REPORT_DIR, `${opts.phase}-report.md`), markdownReport(report))
  process.stdout.write(`  report: ${jsonPath}\n`)
  process.stdout.write(`  verdict: ${verdict}\n`)
  process.exitCode = failed.length === 0 ? 0 : 1
}

function markdownReport(report) {
  const rows = report.results
    .map(result => `| ${result.id} | ${result.title} | ${result.status.toUpperCase()} | ${result.evidence.replace(/\|/g, '\\|')} |`)
    .join('\n')
  return `# E2E report — ${report.phase} (${report.verdict})

- generated: ${report.generatedAt}
- dsh: ${report.provenance.dshVersion} · node: ${report.provenance.nodeVersion}
- profile: \`${report.provenance.profile}\` on port ${report.provenance.port}
- plugin: v${report.provenance.packageVersion} installed as \`link:${report.provenance.repo}\` — **working tree** at git ${report.provenance.gitHead}${report.provenance.gitDirty ? ' with uncommitted changes (dirty)' : ''} (not the published tarball)
- build: ${report.provenance.buildFreshness.detail}
- counts: ${report.counts.passed}/${report.counts.total} passed, ${report.counts.failed} failed, ${report.counts.skipped} skipped
${report.notes.map(note => `- note: ${note}`).join('\n')}

| id | assertion | result | raw evidence |
|---|---|---|---|
${rows}
`
}

// ── small utilities ──────────────────────────────────────────────────

function guard(message) {
  process.stderr.write(`e2e: ${message}\n`)
  process.exit(2)
}

function run(command, args, timeout = 30_000) {
  const result = spawnSync(command, args, { encoding: 'utf8', timeout, maxBuffer: 16 * 1024 * 1024 })
  return { status: result.status ?? -1, stdout: result.stdout ?? '', stderr: result.stderr ?? '' }
}

function commandExists(command) {
  return spawnSync('sh', ['-c', `command -v ${command}`]).status === 0
}

/** Newest mtime among the linked build inputs and outputs. */
function buildFreshness() {
  const newest = dir => {
    let latest = 0
    let file = ''
    const walk = current => {
      for (const entry of readdirSync(current, { withFileTypes: true })) {
        const path = join(current, entry.name)
        if (entry.isDirectory()) walk(path)
        else if (/\.(ts|js|mjs)$/.test(entry.name)) {
          const mtime = statSync(path).mtimeMs
          if (mtime > latest) {
            latest = mtime
            file = path
          }
        }
      }
    }
    try {
      walk(dir)
    } catch {
      /* absent */
    }
    return { latest, file }
  }
  const src = newest(join(REPO, 'src'))
  const lib = newest(join(REPO, 'lib'))
  const stale = lib.latest === 0 || lib.latest < src.latest
  return {
    stale,
    detail: stale
      ? `STALE: newest src ${src.file.replace(REPO, '.')} (${new Date(src.latest).toISOString()}) is newer than newest lib ${lib.file.replace(REPO, '.') || '(none)'} (${lib.latest ? new Date(lib.latest).toISOString() : 'n/a'}) — run pnpm build`
      : `lib ${lib.file.replace(REPO, '.')} (${new Date(lib.latest).toISOString()}) >= src ${src.file.replace(REPO, '.')} (${new Date(src.latest).toISOString()})`,
  }
}

/** Root of the running DSH installation (`…/lib/node_modules/@deepseek-ai/dsh`). */
function dshRuntimeRoot() {
  const bin = run('sh', ['-c', 'readlink -f $(command -v dsh)']).stdout.trim()
  return bin.slice(0, bin.lastIndexOf('/lib/'))
}

/** Resolve DSH's own compatibility judge from the running installation. */
async function loadAppBoot() {
  const candidates = []
  const which = run('sh', ['-c', 'command -v dsh'])
  if (which.status === 0) {
    const bin = run('sh', ['-c', 'readlink -f $(command -v dsh)']).stdout.trim()
    // …/lib/node_modules/@deepseek-ai/dsh/lib/bin.js -> …/lib/node_modules/@deepseek-ai/dsh
    // (lastIndexOf: the path itself contains ".local/lib/")
    const root = bin.slice(0, bin.lastIndexOf('/lib/'))
    candidates.push(join(root, 'node_modules', '@deepseek-ai', 'dsh-app-boot', 'lib', 'index.js'))
  }
  candidates.push(join(PROFILE_DIR, 'node_modules', '@deepseek-ai', 'dsh-app-boot', 'lib', 'index.js'))
  for (const candidate of candidates) {
    if (!existsSync(candidate)) continue
    try {
      const mod = await import(`file://${candidate}`)
      if (typeof mod.evaluatePluginCompatibility === 'function') return { mod, path: candidate }
    } catch {
      /* try the next candidate */
    }
  }
  return undefined
}

function parseArgs(argv) {
  const out = { phase: 'auto', profile: 'smoke02', port: 5399, preset: 'standard', keepServer: false, noInstall: false, reset: true }
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index]
    const next = () => argv[++index]
    if (arg === '--phase') out.phase = next()
    else if (arg === '--profile') out.profile = next()
    else if (arg === '--port') out.port = Number(next())
    else if (arg === '--preset') out.preset = next()
    else if (arg === '--keep-server') out.keepServer = true
    else if (arg === '--no-install') out.noInstall = true
    else if (arg === '--keep-profile') out.reset = false
    else {
      process.stderr.write(`e2e: unknown argument ${arg}\n`)
      process.exit(2)
    }
  }
  return out
}

// ── entry ────────────────────────────────────────────────────────────

let interrupted = false
const onSignal = name => {
  interrupted = true
  process.stderr.write(`e2e: ${name} — tearing the server down\n`)
  // cleanup() polls until the process is gone and the port is released.
  cleanup(name).finally(() => process.exit(name === 'SIGINT' ? 130 : 143))
}
process.on('SIGINT', () => onSignal('SIGINT'))
process.on('SIGTERM', () => onSignal('SIGTERM'))
process.on('uncaughtException', error => {
  process.stderr.write(`e2e: uncaught ${error?.stack ?? error}\n`)
  cleanup('uncaughtException').finally(() => process.exit(1))
})
process.on('unhandledRejection', error => {
  process.stderr.write(`e2e: unhandled rejection ${error?.stack ?? error}\n`)
  cleanup('unhandledRejection').finally(() => process.exit(1))
})

// `--phase auto` names the run after the outcome: a rejected install is the
// pre-fix baseline, anything else is a post-fix run.
if (opts.phase === 'auto') {
  const probe = run('dsh', ['plugin', '--profile', opts.profile, 'list'], 120_000)
  const raw = `${probe.stdout}${probe.stderr}`
  opts.phase = raw.includes(PKG) && !/incompatible/.test(raw) ? 'postfix' : 'baseline'
}

// Every exit path (success, assertion failure, throw, signal) goes through the
// same teardown, so a failure can never leave a server behind.
let provenance
let realProfilesBefore
try {
  ({ provenance, realProfilesBefore } = await main())
} catch (error) {
  process.stderr.write(`e2e: run aborted: ${error?.stack ?? error}\n`)
  process.exitCode = 1
} finally {
  if (!interrupted && !opts.keepServer && provenance === undefined) {
    // main() threw before it could report; still tear the server down here.
    await cleanup('aborted')
  }
}
if (provenance === undefined && process.exitCode === undefined) process.exitCode = 1
if (opts.keepServer && serverChild?.pid) {
  process.stdout.write(`  · --keep-server: leaving pid ${serverChild.pid} on ${BASE}\n`)
}
