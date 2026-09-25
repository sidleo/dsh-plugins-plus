/**
 * Smoke test for the takeover engine and the configuration contract.
 *
 * Runs against the BUILT bundle (`lib/`), so it also proves the build output is
 * importable: the test fails if a value import leaks a declaration-only path,
 * if the schema stops resolving, or if the engine stops being idempotent.
 *
 *   pnpm build && node scripts/smoke.mjs
 *
 * The migration cases point `DSH_HOME` at a scratch directory, so the real
 * `~/.dsh` is never read or written.
 *
 * @module scripts/smoke
 */

import assert from 'node:assert/strict'
import { mkdtempSync, readdirSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const scratch = mkdtempSync(join(tmpdir(), 'dsh-plugins-plus-smoke-'))
process.env.DSH_HOME = scratch

const bundle = await import('../lib/index.js')

let passed = 0
const failures = []

/** Run one named check. */
function check(name, run) {
  try {
    run()
    passed += 1
    console.log(`  ✓ ${name}`)
  } catch (error) {
    failures.push({ name, error })
    console.log(`  ✗ ${name}\n      ${error instanceof Error ? error.message : String(error)}`)
  }
}

console.log(`dsh-plugins-plus smoke test (DSH_HOME=${scratch})`)

// ── Schema ───────────────────────────────────────────────────────────

console.log('\nschema')

check('exposes the plugin entry points', () => {
  assert.equal(bundle.name, 'dsh-plugins-plus')
  assert.equal(typeof bundle.apply, 'function')
  assert.equal(bundle.Config !== undefined, true)
})

check('resolves defaults through volatile references', () => {
  const resolved = bundle.Config({})
  assert.equal(typeof resolved.presetsMode.get, 'function', 'presetsMode must be a volatile reference')
  assert.equal(resolved.presetsMode.get(), 'list')
  assert.deepEqual(resolved.presets.get(), [])
  const components = resolved.components.get()
  assert.equal(components['skill-filesystem-plus'].scanProject, true)
  assert.equal(components['skill-filesystem-plus'].scanParents, false)
  assert.deepEqual(components['skill-filesystem-plus'].parentDirs, [{ name: '.dsh' }, { name: '.agents' }])
  assert.deepEqual(components['agent-instructions-plus'].instructionFileCandidates, ['AGENTS.md', 'CLAUDE.md'])
})

check('keeps a supplied value over the default', () => {
  const resolved = bundle.Config({ presetsMode: 'all', presets: ['yh-standard'] })
  assert.equal(resolved.presetsMode.get(), 'all')
  assert.deepEqual(resolved.presets.get(), ['yh-standard'])
})

check('normalizes a hand-edited subtree', () => {
  const snapshot = bundle.readSnapshot({
    presetsMode: 'bogus',
    presets: ['a', 'a', '', 7],
    components: {
      'skill-filesystem-plus': { scanParents: true, scanProject: true, parentDirs: [{ name: '.pi' }, { name: 'x/y' }] },
    },
  })
  assert.equal(snapshot.presetsMode, 'list')
  assert.deepEqual(snapshot.presets, ['a'])
  assert.equal(snapshot.components['skill-filesystem-plus'].scanParents, true)
  assert.equal(snapshot.components['skill-filesystem-plus'].scanProject, false, 'scanParents wins the exclusivity rule')
  assert.deepEqual(snapshot.components['skill-filesystem-plus'].parentDirs, [{ name: '.pi' }])
})

// ── Inheritance ──────────────────────────────────────────────────────

console.log('\nglobal / component inheritance')

const baseSnapshot = {
  presetsMode: 'list',
  presets: ['yh-standard'],
  components: bundle.normalizeComponents({}),
}

check('a component inherits the global selection by default', () => {
  const selection = bundle.effectivePresetSelection(baseSnapshot, 'skill-filesystem-plus')
  assert.equal(selection.inherited, true)
  assert.deepEqual(selection.presets, ['yh-standard'])
})

check('a component can select its own presets', () => {
  const snapshot = {
    ...baseSnapshot,
    components: bundle.normalizeComponents({
      'skill-filesystem-plus': { useGlobalPresets: false, presetsMode: 'list', presets: ['ptc'] },
    }),
  }
  const selection = bundle.effectivePresetSelection(snapshot, 'skill-filesystem-plus')
  assert.equal(selection.inherited, false)
  assert.deepEqual(selection.presets, ['ptc'])
  assert.deepEqual(
    bundle.effectivePresetSelection(snapshot, 'agent-instructions-plus').presets,
    ['yh-standard'],
    'the other component keeps following the global selection',
  )
})

// ── Planner ──────────────────────────────────────────────────────────

console.log('\ntakeover planner')

const [instructions, skills] = bundle.COMPONENTS
const intent = (component, active) => ({ component, active, manageable: true })

/** A shipped preset, shaped like `dsh-web-app/presets/standard.patch.yml`. */
function shippedStandard() {
  return {
    id: 'standard',
    name: 'Standard',
    plugins: [
      { id: 'persona', name: '@deepseek-ai/dsh-persona' },
      { id: 'agent-instructions', name: '@deepseek-ai/dsh-agent-instructions', config: { maxBytes: 65536 } },
      { id: 'tool-bash', name: '@deepseek-ai/dsh-tool-bash', disabled: { __jsExpr: "process.platform === 'win32'" } },
      { id: 'skill-filesystem', name: '@deepseek-ai/dsh-skill-filesystem' },
    ],
  }
}

/** Plan one preset the way the engine does. */
function plan({ base, inherited, overridden, intents }) {
  return bundle.planPreset({
    presetId: 'standard',
    rowId: 'preset-standard',
    base,
    inherited,
    overridden,
    intents,
  })
}

const shipped = shippedStandard()
const takeover = plan({
  base: shipped,
  inherited: shipped,
  overridden: false,
  intents: [intent(skills, true), intent(instructions, false)],
})

check('activation disables the built-in row and appends the pipeline row', () => {
  assert.equal(takeover.action, 'write')
  const rows = takeover.next.plugins
  assert.equal(rows.find(row => row.id === 'skill-filesystem').disabled, true)
  assert.equal(rows.find(row => row.id === 'agent-instructions').disabled, undefined)
  assert.deepEqual(rows[rows.length - 1], {
    id: 'dsh-plugins-plus-skill-filesystem',
    name: '@sidleo3/dsh-plugins-plus/skill-filesystem/preset',
  })
  assert.deepEqual(takeover.activeComponents, ['skill-filesystem-plus'])
})

check('preserves !!js markers and untouched rows verbatim', () => {
  const rows = takeover.next.plugins
  assert.deepEqual(rows.find(row => row.id === 'tool-bash').disabled, { __jsExpr: "process.platform === 'win32'" })
  assert.deepEqual(rows.find(row => row.id === 'persona'), { id: 'persona', name: '@deepseek-ai/dsh-persona' })
  assert.deepEqual(rows.find(row => row.id === 'agent-instructions').config, { maxBytes: 65536 })
})

check('carries every other key of the layer', () => {
  assert.equal(takeover.next.id, 'standard')
  assert.equal(takeover.next.name, 'Standard')
})

check('is idempotent: a second pass writes nothing', () => {
  const again = plan({
    base: takeover.next,
    inherited: shipped,
    overridden: true,
    intents: [intent(skills, true), intent(instructions, false)],
  })
  assert.equal(again.action, 'none')
})

check('deactivation restores the shipped composition exactly', () => {
  const restored = plan({
    base: takeover.next,
    inherited: shipped,
    overridden: true,
    intents: [intent(skills, false), intent(instructions, false)],
  })
  assert.equal(restored.action, 'write', 'the override must be rewritten so the editor can drop it')
  assert.deepEqual(restored.next, shipped, 'the rewritten config must equal the shipped layer, byte for byte')
})

check('deactivation leaves no `disabled: false` behind', () => {
  const restored = plan({
    base: takeover.next,
    inherited: shipped,
    overridden: true,
    intents: [intent(skills, false), intent(instructions, false)],
  })
  assert.equal(Object.hasOwn(restored.next.plugins.find(row => row.id === 'skill-filesystem'), 'disabled'), false)
})

check('a shipped `disabled` gate is restored, not dropped', () => {
  const inherited = {
    ...shipped,
    plugins: shipped.plugins.map(row =>
      row.id === 'skill-filesystem' ? { ...row, disabled: { __jsExpr: 'false' } } : row,
    ),
  }
  const restored = plan({
    base: { ...inherited, plugins: inherited.plugins.map(row => (row.id === 'skill-filesystem' ? { ...row, disabled: true } : row)) },
    inherited,
    overridden: true,
    intents: [intent(skills, false), intent(instructions, false)],
  })
  assert.deepEqual(restored.next.plugins.find(row => row.id === 'skill-filesystem').disabled, { __jsExpr: 'false' })
})

check('both components share one composition', () => {
  const both = plan({
    base: shipped,
    inherited: shipped,
    overridden: false,
    intents: [intent(instructions, true), intent(skills, true)],
  })
  const ids = both.next.plugins.map(row => row.id)
  assert.equal(both.next.plugins.find(row => row.id === 'agent-instructions').disabled, true)
  assert.equal(both.next.plugins.find(row => row.id === 'skill-filesystem').disabled, true)
  assert.deepEqual(ids.slice(-2), ['dsh-plugins-plus-agent-instructions', 'dsh-plugins-plus-skill-filesystem'])
  const shrunk = plan({
    base: both.next,
    inherited: shipped,
    overridden: true,
    intents: [intent(instructions, false), intent(skills, true)],
  })
  assert.equal(shrunk.next.plugins.some(row => row.id === 'dsh-plugins-plus-agent-instructions'), false)
  assert.equal(shrunk.next.plugins.find(row => row.id === 'agent-instructions').disabled, undefined)
  assert.equal(shrunk.next.plugins.find(row => row.id === 'skill-filesystem').disabled, true)
})

check('keeps a foreign row and a foreign tweak an override added', () => {
  const foreign = {
    ...shipped,
    plugins: [
      ...shipped.plugins.map(row => (row.id === 'persona' ? { ...row, config: { prefix: 'custom' } } : row)),
      { id: 'other-plugin', name: '@acme/other-plugin' },
    ],
  }
  const planned = plan({
    base: foreign,
    inherited: shipped,
    overridden: true,
    intents: [intent(skills, true)],
  })
  assert.deepEqual(planned.next.plugins.find(row => row.id === 'persona').config, { prefix: 'custom' })
  assert.deepEqual(planned.next.plugins.find(row => row.id === 'other-plugin'), {
    id: 'other-plugin',
    name: '@acme/other-plugin',
  })
  assert.equal(planned.next.plugins.find(row => row.id === 'skill-filesystem').disabled, true)
})

check('follows an upstream row change instead of a stale copy', () => {
  const stale = { ...shipped, plugins: shipped.plugins.map(row => ({ ...row })) }
  const upstream = {
    ...shipped,
    plugins: [
      ...shipped.plugins,
      { id: 'tool-new', name: '@deepseek-ai/dsh-tool-new' },
    ],
  }
  const planned = plan({
    base: stale,
    inherited: upstream,
    overridden: true,
    intents: [intent(skills, true)],
  })
  assert.equal(
    planned.next.plugins.some(row => row.id === 'tool-new'),
    true,
    'a row the shipped layer gained must reach the preset',
  )
})

check('rewrites an earlier release\'s pipeline row instead of duplicating it', () => {
  const legacy = {
    ...shipped,
    plugins: [
      ...shipped.plugins.map(row => (row.id === 'skill-filesystem' ? { ...row, disabled: true } : row)),
      { id: 'skill-filesystem-plus-pipeline', name: '@sidleo3/skill-filesystem-plus/preset' },
    ],
  }
  const planned = plan({
    base: legacy,
    inherited: shipped,
    overridden: true,
    intents: [intent(skills, true), intent(instructions, false)],
  })
  const ids = planned.next.plugins.map(row => row.id)
  assert.deepEqual(ids.filter(id => id.includes('pipeline') || id.startsWith('dsh-plugins-plus-')), [
    'dsh-plugins-plus-skill-filesystem',
  ])
})

check('reports a preset without the built-in row as not applicable', () => {
  const minimal = { id: 'minimal', plugins: [{ id: 'persona', name: '@deepseek-ai/dsh-persona' }] }
  const planned = plan({
    base: minimal,
    inherited: minimal,
    overridden: false,
    intents: [intent(skills, true), intent(instructions, false)],
  })
  assert.deepEqual(planned.activeComponents, [])
  assert.equal(planned.action, 'none')
  assert.match(planned.problems.join(' '), /不含 skill-filesystem 行/)
})

check('leaves rows alone while a component has never mounted', () => {
  const unmanaged = plan({
    base: takeover.next,
    inherited: shipped,
    overridden: true,
    intents: [
      { component: skills, active: false, manageable: false },
      { component: instructions, active: false, manageable: false },
    ],
  })
  assert.equal(unmanaged.action, 'none', 'an unmanaged pass must not touch the composition')
  assert.deepEqual(unmanaged.next, takeover.next)
})

check('mergeRows is a no-op when the layers agree', () => {
  assert.deepEqual(bundle.mergeRows(shipped.plugins, shipped.plugins, bundle.COMPONENTS), shipped.plugins)
})

// ── Legacy migration ─────────────────────────────────────────────────

console.log('\nlegacy migration')

check('imports the standalone plugins\' settings files', () => {
  writeFileSync(
    join(scratch, 'dsh-skill-filesystem-plus.json'),
    JSON.stringify({ scanParents: true, scanProject: false, parentDirs: [{ name: '.dsh' }, { name: '.pi' }] }),
  )
  writeFileSync(
    join(scratch, 'dsh-instruction-scan.json'),
    JSON.stringify({ scanParents: true, scanProject: false, maxBytes: 32768, dshHome: '~/.dsh' }),
  )
  const files = bundle.readLegacyConfigs()
  const skills = files.find(file => file.componentId === 'skill-filesystem-plus')
  assert.deepEqual(skills.values.parentDirs, [{ name: '.dsh' }, { name: '.pi' }])
  const instructions = files.find(file => file.componentId === 'agent-instructions-plus')
  assert.equal(instructions.values.maxBytes, 32768)
})

check('seeds only the fields the profile does not declare', () => {
  const compositions = [
    {
      presetId: 'yh-standard',
      rowId: 'preset-yh-standard',
      isDefault: true,
      inherited: {},
      override: {},
      overridden: false,
      base: {},
      rows: [{ id: 'skill-filesystem-plus-pipeline', name: '@sidleo3/skill-filesystem-plus/preset' }],
      inheritedRows: [{ id: 'skill-filesystem', name: '@deepseek-ai/dsh-skill-filesystem' }],
      entry: { options: { id: 'preset-yh-standard', name: bundle.PRESET_MODULE } },
    },
  ]
  const seed = bundle.buildMigrationSeed({
    currentOverride: { components: { 'skill-filesystem-plus': { scanCwd: false } } },
    compositions,
    components: bundle.COMPONENTS,
  })
  assert.equal(seed.components['skill-filesystem-plus'].scanCwd, undefined, 'an explicit value must not be overwritten')
  assert.deepEqual(seed.components['skill-filesystem-plus'].parentDirs, [{ name: '.dsh' }, { name: '.pi' }])
  assert.deepEqual(Object.keys(seed.adoptedPresets), ['skill-filesystem-plus'])
  assert.deepEqual(seed.components['skill-filesystem-plus'].presets, ['yh-standard'])
  assert.equal(seed.components['skill-filesystem-plus'].useGlobalPresets, false)
})

check('does not adopt a takeover the user already re-selected', () => {
  const compositions = [
    {
      presetId: 'yh-standard',
      rowId: 'preset-yh-standard',
      isDefault: true,
      inherited: {},
      override: {},
      overridden: false,
      base: {},
      rows: [{ id: 'skill-filesystem-plus-pipeline', name: '@sidleo3/skill-filesystem-plus/preset' }],
      inheritedRows: [],
      entry: { options: { id: 'preset-yh-standard', name: bundle.PRESET_MODULE } },
    },
  ]
  const seed = bundle.buildMigrationSeed({
    currentOverride: { presetsMode: 'all', presets: [] },
    compositions,
    components: bundle.COMPONENTS,
  })
  assert.equal(seed.adoptedPresets, undefined)
})

check('records the import instead of touching the shared legacy files', () => {
  const timestamp = '2026-09-25T00:00:00.000Z'
  const repeat = bundle.buildMigrationSeed({
    currentOverride: { legacyImport: timestamp },
    compositions: [],
    components: bundle.COMPONENTS,
  })
  assert.equal(repeat.components, undefined, 'a recorded import must not run again')
  assert.deepEqual(repeat.notes, [])
  assert.equal(
    bundle.listLegacyFiles().some(path => path.endsWith('dsh-skill-filesystem-plus.json')),
    true,
    'the legacy file must still be there for other profiles',
  )
  assert.equal(
    readdirSync(scratch).some(name => name.includes('.migrated-')),
    false,
    'the import must never rename a file in the shared DSH home',
  )
})

// ── Client bundle ────────────────────────────────────────────────────

console.log('\nclient bundle')

/**
 * Load the browser half the way the DSH client module system does: a plain
 * script that registers a CJS factory on `window.__ModuleLoader__`, with
 * platform modules coming from the module table. `react` is the real library
 * when it is installed, so the page can also be rendered.
 */
async function loadClientBundle(react) {
  let captured
  globalThis.window = {
    __ModuleLoader__: {
      load(definition) {
        captured = definition
      },
    },
  }
  await import('../lib/client.js')
  assert.ok(captured, 'the bundle must register itself with __ModuleLoader__')
  assert.equal(captured.id, '@sidleo3/dsh-plugins-plus')
  const platform = react ?? {
    createElement: (type, props, ...children) => ({ type, props, children }),
    useState: initial => [typeof initial === 'function' ? initial() : initial, () => {}],
    useEffect: () => {},
    useMemo: factory => factory(),
    useCallback: callback => callback,
    Fragment: 'Fragment',
  }
  return captured.factory(name => {
    if (name === 'react') return platform
    if (name === 'react/jsx-runtime') return platform
    throw new Error(`unexpected platform module request: ${name}`)
  })
}

const registeredPages = new Map()
const clientRegistry = []
const clientContext = {
  get(name) {
    if (name === 'slots') {
      return {
        inject(key, callback) {
          clientRegistry.push(key)
          callback()
        },
        register(definition, component) {
          const label = `${definition.name}:${definition.key ?? definition.id ?? ''}`
          clientRegistry.push(label)
          registeredPages.set(label, component)
          return () => {}
        },
      }
    }
    if (name === 'configForms') {
      return {
        get() {
          return {
            getSnapshot: () => ({
              status: 'ready',
              writable: true,
              revision: 1,
              base: {},
              user: {},
              value: {
                presetsMode: 'list',
                presets: ['standard'],
                legacyImport: '',
                components: {
                  'agent-instructions-plus': {
                    useGlobalPresets: true,
                    presetsMode: 'list',
                    presets: [],
                    scanCwd: true,
                    scanProject: false,
                    scanParents: true,
                    scanGlobal: true,
                    instructionFileCandidates: ['AGENTS.md', 'CLAUDE.md'],
                    localInstructionFileCandidates: ['AGENTS.local.md'],
                    projectRootMarkers: ['.git'],
                    dshHome: '~/.dsh',
                    maxBytes: 65536,
                    maxSourceBytes: 1048576,
                  },
                  'skill-filesystem-plus': {
                    useGlobalPresets: true,
                    presetsMode: 'list',
                    presets: [],
                    scanCwd: true,
                    scanProject: true,
                    scanParents: false,
                    scanGlobal: true,
                    parentDirs: [{ name: '.dsh' }, { name: '.agents' }],
                  },
                },
              },
            }),
            subscribe: () => () => {},
            mutate: async () => true,
            set: async () => true,
            unset: async () => true,
          }
        },
      }
    }
    if (name === 'locale') {
      return { register: () => () => {}, bind: () => key => key, subscribe: () => () => {} }
    }
    return undefined
  },
}

const client = await loadClientBundle((await import('react')).default)

check('registers a Settings section and both Plugins-page surfaces', () => {
  assert.equal(typeof client.apply, 'function')
  assert.deepEqual(client.inject, ['slots', 'remote'])
  client.apply(clientContext)
  assert.ok(clientRegistry.includes('settings.section'), 'missing the Settings section')
  assert.ok(
    clientRegistry.includes('plugins.bundle.config:@sidleo3/dsh-plugins-plus'),
    'missing the bundle configuration page',
  )
  for (const rowId of ['dsh-plugins-plus', 'agent-instructions-plus', 'skill-filesystem-plus']) {
    assert.ok(
      clientRegistry.includes(`plugins.row.config:@sidleo3/dsh-plugins-plus#${rowId}`),
      `missing the configuration page for row ${rowId}`,
    )
  }
  assert.equal(registeredPages.size, 5)
})

// The dark buttons are background `label-primary` with `bg-layer-3` text; the
// generic hover rule paints the text `label-primary` too, which erases it. The
// fix only holds while the solid-button rule comes after that one.
check('the solid button keeps its contrast colour while hovered', () => {
  const bundle = readFileSync(new URL('../lib/client.js', import.meta.url), 'utf8')
  const generic = bundle.indexOf('.dppBtn:hover:not(:disabled){')
  const solid = bundle.indexOf('.dppBtnPrimary:hover:not(:disabled){')
  assert.ok(generic >= 0, 'the generic hover rule is gone')
  assert.ok(solid >= 0, 'the solid button lost its hover rule')
  assert.ok(solid > generic, 'the solid-button hover rule must come after the generic one')
  const declarations = bundle.slice(solid, bundle.indexOf('}', solid))
  assert.ok(
    declarations.includes('color:var(--dsw-alias-bg-layer-3)'),
    'the hovered solid button must keep the layer colour as its text',
  )
})

// Async checks: each surface is rendered server-side with the real React and
// the values a live host would hand over, which catches a render-time crash
// (and a silently empty panel) that a registration-only test would miss.
const React = (await import('react')).default
const { renderToStaticMarkup } = await import('react-dom/server')

/** Render one registered slot component and assert what must be visible. */
function checkRender(name, key, expected) {
  try {
    const component = registeredPages.get(key)
    assert.ok(component, `no component registered for ${key}`)
    const markup = renderToStaticMarkup(React.createElement(component))
    for (const text of expected) {
      assert.ok(markup.includes(text), `the rendered page is missing "${text}"`)
    }
    passed += 1
    console.log(`  ✓ ${name}`)
  } catch (error) {
    failures.push({ name, error })
    console.log(`  ✗ ${name}\n      ${error.message}`)
  }
}

checkRender('renders the Settings section with both component cards', 'settings.section:dsh-plugins-plus', [
  '全局配置',
  'agent-instructions-plus',
  'skill-filesystem-plus',
  // Host data (the preset roster) arrives from the status route after mount,
  // so a first render must stand on its own: the global card, the mode picker
  // and the action buttons are all local.
  '仅勾选的预设',
  '所有预设',
  '不接管',
  '保存全局配置',
  '立即应用',
  '正在读取预设状态',
])

checkRender(
  'renders the skill component page',
  'plugins.row.config:@sidleo3/dsh-plugins-plus#skill-filesystem-plus',
  ['继承全局', '上级目录名', '保存', '恢复默认'],
)

checkRender(
  'renders the instruction component page',
  'plugins.row.config:@sidleo3/dsh-plugins-plus#agent-instructions-plus',
  ['指令文件名', '项目根标记', 'maxBytes'],
)

// `⌃` and `⌄` are different glyphs (own weight, own baseline), so an expanded
// card never mirrored a collapsed one. One chevron, rotated in the open state.
check('expand and collapse share one chevron glyph', () => {
  const section = renderToStaticMarkup(
    React.createElement(registeredPages.get('settings.section:dsh-plugins-plus')),
  )
  assert.ok(!section.includes('⌃') && !section.includes('⌄'), 'the text arrowheads are back')
  assert.ok(
    section.includes('class="dppChevron dppChevronOpen"'),
    'the open card must mark its chevron as open',
  )
  assert.ok(
    (section.match(/class="dppChevron"/g) ?? []).length >= 2,
    'the collapsed cards must render the same chevron, unrotated',
  )
  const bundle = readFileSync(new URL('../lib/client.js', import.meta.url), 'utf8')
  assert.ok(
    bundle.includes('.dppChevronOpen{transform:rotate(180deg)}'),
    'the open state must be the same glyph rotated, not a second drawing',
  )
})

// ── Report ───────────────────────────────────────────────────────────

console.log('')
if (failures.length > 0) {
  console.error(`${failures.length} check(s) failed, ${passed} passed`)
  for (const failure of failures) console.error(`  ✗ ${failure.name}: ${failure.error?.message ?? failure.error}`)
  process.exit(1)
}
console.log(`all ${passed} checks passed`)
