/**
 * Bundle the browser half into the harness client-bundle format.
 *
 * This is NOT an ordinary ESM bundle. The harness browser runtime is a lazy
 * CJS module table: executing a plugin bundle must only REGISTER a factory via
 *
 *   window.__ModuleLoader__.load({ id, factory: (require) => { ... } })
 *
 * and the factory receives a synchronous `require` bound to that table. Shared
 * singletons — React above all — are resolved through it, never imported. A
 * bare `import "react"` would fail outright: the page ships no import map, and
 * inlining a second React would break hooks against the host's instance.
 *
 * The banner/footer/intro triple below reproduces the contract from the
 * harness's own preset (packages/client/tsdown.client.ts); `format: 'cjs'` is
 * what makes esbuild emit `require(...)` calls the injected require answers.
 *
 * Externals must match the host's frozen table exactly. Anything else — Vega
 * included — is inlined, because a `require()` the table cannot answer throws
 * at materialization.
 */

import { build } from 'esbuild'

/** The plugin id, i.e. the package name. Must match the boot-graph row. */
const ID = 'openanalyst'

/**
 * `PLATFORM_MODULES` from @deepseek-ai/dsh-client-web/src/platform.ts, plus the
 * documented `dsh-client-runtime/client` exemption. Keep in sync with the
 * harness; a drift here surfaces as a runtime "cannot require" throw.
 */
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
  '@deepseek-ai/dsh-client-runtime/client',
]

const NODE_ENV = process.env.NODE_ENV ?? 'production'

const result = await build({
  entryPoints: ['src/client/index.ts'],
  outfile: 'lib/client.js',
  bundle: true,
  format: 'cjs',
  platform: 'browser',
  target: ['es2022'],
  external: CLIENT_EXTERNALS,
  minify: true,
  sourcemap: true,
  // Inlined browser deps read Node/Vite idioms that a CJS output cannot carry;
  // without these substitutions the factory throws at boot.
  define: {
    'process.env.NODE_ENV': JSON.stringify(NODE_ENV),
    'import.meta.env.MODE': JSON.stringify(NODE_ENV),
    'import.meta.env': JSON.stringify({ MODE: NODE_ENV }),
  },
  banner: {
    js:
      `window.__ModuleLoader__.load({ id: ${JSON.stringify(ID)}, factory: (require) => {` +
      ' var module = { exports: {} }; var exports = module.exports;',
  },
  footer: { js: 'return module.exports; } });' },
  logLevel: 'info',
})

if (result.errors.length > 0) process.exitCode = 1
