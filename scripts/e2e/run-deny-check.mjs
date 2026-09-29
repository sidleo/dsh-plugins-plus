#!/usr/bin/env node
/**
 * Reproduce DSH's LOAD-TIME compatibility preflight in the scratch profile.
 *
 * `dsh plugin add` refuses an incompatible manifest outright, so the situation a
 * user actually ends up in — package installed, rows silently denied at boot —
 * only appears when the install gate is bypassed. The exact-version exemption is
 * DSH's own supported way to do that, so this script:
 *
 *   1. builds a pre-fix copy of this package (peers from git rev 642bb8e, i.e.
 *      the shipped 0.1.5 manifest, linked to the current build outputs),
 *   2. shows the install gate refusing it, verbatim,
 *   3. grants the exemption and installs it anyway,
 *   4. boots the profile and captures the preflight denial line,
 *   5. proves the user-visible symptom: the plugin's own route 404s and its
 *      settings namespace is not served,
 *   6. restores the profile (revokes the exemption, reinstalls the current repo).
 *
 * Usage: node scripts/e2e/run-deny-check.mjs [--profile smoke02] [--port 5396]
 * Exit:  0 = the denial was reproduced and the profile was restored, 1 = not
 *        reproduced / a step failed, 2 = refused to run.
 */

import { spawn, spawnSync } from 'node:child_process'
import { existsSync, mkdirSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { connect } from 'node:net'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const HERE = dirname(fileURLToPath(import.meta.url))
const REPO = resolve(HERE, '..', '..')
const REPORT_DIR = join(HERE, 'reports')
const TMP = join(HERE, '.tmp', 'prefix-0.1.5')
const DSH_HOME = process.env.DSH_HOME ?? join(process.env.HOME, '.dsh')
const PKG = '@sidleo3/dsh-plugins-plus'
const PRE_FIX_REV = '642bb8e'
const DENY_PATTERNS = [/skipping profile bundle "[^"]*dsh-plugins-plus/, /disabling profile plugin row "[^"]*dsh-plugins-plus/, /incompatible with dsh/]

const opts = { profile: 'smoke02', port: 5396 }
for (let index = 2; index < process.argv.length; index += 1) {
  const arg = process.argv[index]
  if (arg === '--profile') opts.profile = process.argv[++index]
  else if (arg === '--port') opts.port = Number(process.argv[++index])
  else {
    process.stderr.write(`deny-check: unknown argument ${arg}\n`)
    process.exit(2)
  }
}
const PROFILE_DIR = join(DSH_HOME, 'profiles', opts.profile)
const BASE = `http://127.0.0.1:${opts.port}`
const results = []

function record(id, title, status, evidence = '') {
  results.push({ id, title, status, evidence: String(evidence).replace(/\s+/g, ' ').trim() })
  process.stdout.write(`  [${status.toUpperCase()}] ${id} ${title}\n         ${String(evidence).replace(/\s+/g, ' ').trim().slice(0, 500)}\n`)
}

function run(command, args, timeout = 300_000) {
  const result = spawnSync(command, args, { encoding: 'utf8', timeout, maxBuffer: 32 * 1024 * 1024 })
  return { status: result.status ?? -1, out: `${result.stdout ?? ''}${result.stderr ?? ''}`.trim() }
}

function guard(message) {
  process.stderr.write(`deny-check: ${message}\n`)
  process.exit(2)
}

function portFree(port) {
  return new Promise(resolvePromise => {
    const socket = connect({ host: '127.0.0.1', port })
    const done = value => { socket.destroy(); resolvePromise(value) }
    socket.once('connect', () => done(false))
    socket.once('error', () => done(true))
    setTimeout(() => done(true), 1000)
  })
}

const sleep = ms => new Promise(resolvePromise => setTimeout(resolvePromise, ms))

async function main() {
  mkdirSync(REPORT_DIR, { recursive: true })
  if (['desktop', 'web'].includes(opts.profile)) guard(`refusing to run against real profile "${opts.profile}"`)
  if (opts.port === 19387) guard('refusing to bind the desktop app port')
  if (!existsSync(join(PROFILE_DIR, 'package.json'))) guard(`profile ${opts.profile} not found`)
  if (spawnSync('pgrep', ['-fl', `dsh --profile ${opts.profile}`]).stdout?.toString().trim()) {
    guard(`another dsh is running for ${opts.profile} — stop it first (the E2E run holds the profile lock)`)
  }
  if (!(await portFree(opts.port))) guard(`port ${opts.port} is already in use`)

  const before = {
    packageJson: readFileSync(join(PROFILE_DIR, 'package.json'), 'utf8'),
    patch: existsSync(join(PROFILE_DIR, 'cordis.patch.yml')) ? readFileSync(join(PROFILE_DIR, 'cordis.patch.yml'), 'utf8') : '',
    compatibility: existsSync(join(PROFILE_DIR, 'compatibility.json')) ? readFileSync(join(PROFILE_DIR, 'compatibility.json'), 'utf8') : undefined,
  }

  // ── build the pre-fix package ──────────────────────────────────────
  process.stdout.write('\n0. build a pre-fix copy of the package (peers as shipped in 0.1.5)\n')
  const manifest = run('git', ['-C', REPO, 'show', `${PRE_FIX_REV}:package.json`])
  if (manifest.status !== 0) guard(`git show ${PRE_FIX_REV}:package.json failed: ${manifest.out}`)
  rmSync(TMP, { recursive: true, force: true })
  mkdirSync(TMP, { recursive: true })
  writeFileSync(join(TMP, 'package.json'), manifest.out.endsWith('\n') ? manifest.out : `${manifest.out}\n`)
  for (const entry of ['lib', 'locale', 'cordis.patch.yml', 'README.md']) {
    symlinkSync(join(REPO, entry), join(TMP, entry))
  }
  const peers = JSON.parse(manifest.out).peerDependencies
  record('A1', `pre-fix manifest built from git ${PRE_FIX_REV}`, 'pass',
    `peers=${JSON.stringify(peers)} (linked to the current lib/)`)

  let child
  const cleanup = async reason => {
    if (child?.pid === undefined) return
    for (const signal of ['SIGTERM', 'SIGKILL']) {
      for (const target of [-child.pid, child.pid]) {
        try { process.kill(target, signal) } catch { /* gone */ }
      }
      if (!spawnSync('sh', ['-c', `ps -p ${child.pid} >/dev/null`]).status) break
      await sleep(1500)
    }
    const pid = child.pid
    child = undefined
    process.stdout.write(`  · teardown (${reason}): dsh pid ${pid} killed\n`)
  }

  try {
    // ── the install gate ─────────────────────────────────────────────
    process.stdout.write('\n1. the install gate refuses the incompatible manifest\n')
    const rejected = run('dsh', ['plugin', '--profile', opts.profile, 'add', `link:${TMP}`])
    writeFileSync(join(REPORT_DIR, 'deny-check-install-rejected.log'), rejected.out)
    const refused = rejected.status !== 0 && /incompatible with dsh/.test(rejected.out)
    record('A2', 'dsh plugin add link:<pre-fix> is rejected with the peer incompatibility', refused ? 'pass' : 'fail',
      `exit=${rejected.status} :: ${rejected.out.slice(0, 600)}`)
    if (!refused) throw new Error('the install gate did not refuse the pre-fix manifest — nothing to reproduce')

    process.stdout.write('\n2. bypass the gate with the exact-version exemption (DSH\'s supported path)\n')
    const allowed = run('dsh', ['plugin', '--profile', opts.profile, 'allow-version', `${PKG}@0.1.5`, '--dsh-version', '0.2.0-rc.1', '--accept-risk'])
    record('A3', 'exact-version exemption granted', /allowed/.test(allowed.out) ? 'pass' : 'fail', `exit=${allowed.status} :: ${allowed.out.slice(0, 300)}`)
    const installed = run('dsh', ['plugin', '--profile', opts.profile, 'add', `link:${TMP}`])
    record('A4', 'the pre-fix manifest installs once the exemption is active', installed.status === 0 ? 'pass' : 'fail',
      `exit=${installed.status} :: ${installed.out.slice(0, 300)}`)

    // The exemption is what the install gate is bypassed WITH; the user's real
    // state is "incompatible package installed, no exemption", so revoke it
    // before booting — that is the load-time preflight's own precondition.
    process.stdout.write('\n3. revoke the exemption: installed but not exempt (the user\'s actual state)\n')
    const revoked = run('dsh', ['plugin', '--profile', opts.profile, 'revoke-version', `${PKG}@0.1.5`, '--dsh-version', '0.2.0-rc.1'])
    const exemptions = existsSync(join(PROFILE_DIR, 'compatibility.json')) ? readFileSync(join(PROFILE_DIR, 'compatibility.json'), 'utf8').trim() : 'absent'
    const stillInstalled = JSON.parse(readFileSync(join(PROFILE_DIR, 'package.json'), 'utf8')).dependencies?.[PKG]
    record('A5', 'incompatible package is installed while no exemption is active', /revoked/.test(revoked.out) && !/0\.1\.5/.test(exemptions) ? 'pass' : 'fail',
      `revoke: ${revoked.out.slice(0, 200)}; compatibility.json=${exemptions}; dependency=${stillInstalled}`)

    // ── boot and capture the preflight denial ────────────────────────
    process.stdout.write('\n4. boot: what does the load-time preflight do with it?\n')
    const log = []
    child = spawn('dsh', ['--profile', opts.profile, '--port', String(opts.port), '--no-open'], {
      cwd: REPO, detached: true, stdio: ['ignore', 'pipe', 'pipe'],
    })
    child.stdout.on('data', chunk => log.push(String(chunk)))
    child.stderr.on('data', chunk => log.push(String(chunk)))
    child.unref()

    const text = () => log.join('')
    const deadline = Date.now() + 120_000
    // The denial line is printed by the profile preflight BEFORE the app starts,
    // so capture it first and then keep waiting for the token separately.
    while (Date.now() < deadline && !DENY_PATTERNS.some(pattern => pattern.test(text()))) await sleep(300)
    const denyLine = text().split('\n').find(line => DENY_PATTERNS.some(pattern => pattern.test(line)))
    let token
    while (Date.now() < deadline) {
      token = text().match(/token=([A-Za-z0-9_.-]+)/)?.[1]
      if (token !== undefined) break
      await sleep(300)
    }
    await sleep(1000)
    writeFileSync(join(REPORT_DIR, 'deny-check-boot.log'), text())

    record('B1', 'the preflight denies the bundle at load time (raw stderr line)', denyLine !== undefined ? 'pass' : 'fail',
      denyLine ?? `no denial line; boot log: ${text().slice(0, 400)}`)

    if (token !== undefined) {
      const cookie = await takeCookie(token)
      const status = cookie ? await fetchJson('/api/dsh-plugins-plus/status', cookie) : undefined
      record('B2', 'the plugin\'s own route is dead (404) — the engine never loaded', status?.httpStatus === 404 ? 'pass' : 'fail',
        `GET /api/dsh-plugins-plus/status -> HTTP ${status?.httpStatus} ${String(status?.text ?? '').slice(0, 120)}`)
      const describe = cookie ? await rpc('settings/describe', {}, cookie) : undefined
      const namespaces = describe?.json?.result?.value?.namespaces ?? []
      const served = namespaces.some(entry => entry.ns === 'dsh-plugins-plus')
      record('B3', 'the dsh-plugins-plus settings namespace is not served at all', served ? 'fail' : 'pass',
        `namespaces=${namespaces.length}, dsh-plugins-plus present=${served}`)
    } else {
      record('B2', 'server never printed a token (boot aborted)', 'fail', text().slice(0, 400))
      record('B3', 'settings namespace check skipped', 'fail', 'no token → no authenticated call')
    }

    await cleanup('denial reproduced')
  } finally {
    await cleanup('finally')

    // ── restore ──────────────────────────────────────────────────────
    process.stdout.write('\n5. restore the scratch profile\n')
    run('dsh', ['plugin', '--profile', opts.profile, 'revoke-version', `${PKG}@0.1.5`, '--dsh-version', '0.2.0-rc.1'])
    const back = run('dsh', ['plugin', '--profile', opts.profile, 'add', `link:${REPO}`])
    record('C1', 'the current repo is installed again', back.status === 0 ? 'pass' : 'fail',
      `exit=${back.status} :: ${back.out.split('\n').filter(Boolean).slice(-2).join(' | ').slice(0, 300)}`)
    const after = readFileSync(join(PROFILE_DIR, 'package.json'), 'utf8')
    record('C2', 'profile package.json points back at this repo', after.includes(`link:${REPO}`) ? 'pass' : 'fail',
      `dependency=${JSON.parse(after).dependencies?.[PKG]}`)
    const exemption = existsSync(join(PROFILE_DIR, 'compatibility.json')) ? readFileSync(join(PROFILE_DIR, 'compatibility.json'), 'utf8') : 'absent'
    record('C3', 'no version exemption is left behind', /0\.1\.5/.test(exemption) ? 'fail' : 'pass', `compatibility.json=${exemption.trim() || 'empty'}`)
    const patchNow = existsSync(join(PROFILE_DIR, 'cordis.patch.yml')) ? readFileSync(join(PROFILE_DIR, 'cordis.patch.yml'), 'utf8') : ''
    record('C4', 'profile patch untouched by this run', patchNow === before.patch ? 'pass' : 'fail',
      patchNow === before.patch ? `entries unchanged (${(patchNow.match(/^- id:/gm) ?? []).length})` : `before=${before.patch.length}B after=${patchNow.length}B`)
  }

  const failed = results.filter(result => result.status === 'fail')
  const markdown = `# Load-time compatibility deny — reproduction report

- profile: \`${opts.profile}\` (scratch), port ${opts.port}
- dsh: ${run('dsh', ['--version']).out}
- pre-fix manifest: git ${PRE_FIX_REV} (peers kept at ^0.1.7-alpha.2), linked to the current \`lib/\`
- verdict: ${failed.length === 0 ? 'REPRODUCED' : 'NOT REPRODUCED / incomplete'}

| id | step | result | evidence |
|---|---|---|---|
${results.map(result => `| ${result.id} | ${result.title} | ${result.status.toUpperCase()} | ${result.evidence.replace(/\|/g, '\\|')} |`).join('\n')}

Raw logs: \`deny-check-install-rejected.log\`, \`deny-check-boot.log\`.
`
  writeFileSync(join(REPORT_DIR, 'deny-check-report.md'), markdown)
  writeFileSync(join(REPORT_DIR, 'deny-check-report.json'), `${JSON.stringify({ results, verdict: failed.length === 0 ? 'REPRODUCED' : 'FAILED' }, null, 2)}\n`)
  process.stdout.write(`\nverdict: ${failed.length === 0 ? 'REPRODUCED' : 'FAILED'} — reports/deny-check-report.md\n`)
  process.exitCode = failed.length === 0 ? 0 : 1
}

async function takeCookie(token) {
  const response = await fetch(`${BASE}/?token=${token}`, { redirect: 'manual' })
  const cookie = (response.headers.getSetCookie?.() ?? []).find(value => value.startsWith('dsh-auth-'))
  return cookie?.split(';')[0]
}

async function fetchJson(path, cookie) {
  const response = await fetch(`${BASE}${path}`, { headers: { cookie } })
  return { httpStatus: response.status, text: await response.text() }
}

async function rpc(method, args, cookie) {
  const response = await fetch(`${BASE}/api/${method}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', cookie },
    body: JSON.stringify({ type: 'client-request', rpcId: `deny-${Date.now()}`, method, payload: { args } }),
  })
  const text = await response.text()
  let json
  try { json = JSON.parse(text) } catch { json = undefined }
  return { httpStatus: response.status, text, json }
}

process.on('SIGINT', () => process.exit(130))
await main()
