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
  '@deepseek-ai/dsh-client-runtime',
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
