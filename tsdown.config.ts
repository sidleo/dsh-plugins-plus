import { defineConfig } from 'tsdown'

const PLUGIN_ID = '@sidleo3/dsh-plugins-plus'

/** Platform modules resolved from the DSH loader module table (external in the client half). */
const CLIENT_EXTERNALS = [
  'react',
  'react/jsx-runtime',
  'react-dom',
  'react-dom/client',
  '@deepseek-ai/cordis',
  '@deepseek-ai/dsh-client-ui-slots',
  '@deepseek-ai/dsh-client-web-react',
  '@deepseek-ai/dsh-client-ui-primitives',
  '@deepseek-ai/dsh-client-ui-attachment',
  '@deepseek-ai/dsh-client-schema-form',
]

/**
 * Runtime dependencies the DSH loader resolves for a host/preset row.
 *
 * The union of what both standalone plugins had to externalize in production:
 * the loader's module table serves these specifiers, so importing them stays a
 * real import. Everything else — including `@deepseek-ai/schemastery` and its
 * vendored `@deepseek-ai/cosmokit` — must be BUNDLED: the loader does not expose
 * them as importable modules, so an external `import z from
 * '@deepseek-ai/schemastery'` fails at runtime with ERR_MODULE_NOT_FOUND
 * (pitfall 3 in agent-instructions-plus).
 *
 * Getting this list wrong is silent in both directions: too short inlines a
 * second copy of a runtime package (duplicate identities, surprising weight),
 * too long leaves an import the loader cannot resolve.
 *
 * This table MAY name packages that only ever appear as `import type` — they are
 * erased at build time, so listing them is harmless. The binding rule is on the
 * BUILT PRODUCT, not on this table: every bare import that actually survives
 * into `lib/*.js` must also be a manifest name (`peerDependencies` or
 * `dependencies`), otherwise a `link:`-installed copy cannot resolve it and the
 * row silently never starts (AGENTS.md pitfall 20). `scripts/smoke.mjs` asserts
 * exactly that over `lib/*.js`, so adding a table entry here is not enough —
 * name it in `package.json` too.
 */
const RUNTIME_EXTERNALS = [
  ...CLIENT_EXTERNALS,
  'chokidar',
  'yaml',
  '@deepseek-ai/dsh-llm',
  '@deepseek-ai/dsh-agent',
  '@deepseek-ai/dsh-fs',
  '@deepseek-ai/dsh-session',
  '@deepseek-ai/dsh-tools',
  '@deepseek-ai/dsh-home-paths',
  '@deepseek-ai/dsh-agent-preset',
  '@deepseek-ai/dsh-agent-preset-registry',
  '@deepseek-ai/dsh-skill',
]

const hostOutput = (name, entry) => ({
  name,
  entry,
  format: ['esm'],
  outDir: 'lib',
  outExtension() {
    return { js: '.js', dts: '.d.ts' }
  },
  target: 'node22',
  dts: { minify: false },
  sourcemap: true,
  clean: false,
  external: [...RUNTIME_EXTERNALS],
  noExternal: id => (RUNTIME_EXTERNALS.includes(id) ? undefined : true),
})

/**
 * Build config for @sidleo3/dsh-plugins-plus.
 *
 * Five host/preset entries (core, two component activators, two session-plane
 * pipelines) plus one browser half.
 */
export default defineConfig([
  hostOutput('dsh-plugins-plus/core', { index: 'src/index.ts' }),
  hostOutput('dsh-plugins-plus/agent-instructions', {
    'agent-instructions': 'src/components/agent-instructions/index.ts',
  }),
  hostOutput('dsh-plugins-plus/agent-instructions-preset', {
    'agent-instructions-preset': 'src/components/agent-instructions/preset.ts',
  }),
  hostOutput('dsh-plugins-plus/skill-filesystem', {
    'skill-filesystem': 'src/components/skill-filesystem/index.ts',
  }),
  hostOutput('dsh-plugins-plus/skill-filesystem-preset', {
    'skill-filesystem-preset': 'src/components/skill-filesystem/preset.ts',
  }),
  {
    name: 'dsh-plugins-plus/client',
    entry: { client: 'src/client/index.ts' },
    format: 'cjs',
    platform: 'browser',
    outDir: 'lib',
    dts: false,
    sourcemap: true,
    clean: false,
    external: [...CLIENT_EXTERNALS],
    noExternal: id => (CLIENT_EXTERNALS.includes(id) ? undefined : true),
    outputOptions: {
      entryFileNames: 'client.js',
      banner: `window.__ModuleLoader__.load({ id: ${JSON.stringify(PLUGIN_ID)}, factory: (require) => {`,
      footer: 'return module.exports; } });',
      intro: 'var module = { exports: {} }; var exports = module.exports;',
    },
  },
])
