// Build the argus-distill-eval CLI into dist/cli.js.
//
// Uses esbuild's JS API (not the CLI) so we can set `nodePaths` explicitly:
// the bundle follows relative imports into ../../app/src/main/services/distill/
// and ../../app/src/shared/, which are pure TS modules with no extra npm deps of
// their own — but esbuild resolves any dependency relative to the importing file,
// so a checkout that installs only this package's deps (e.g. CI, which runs
// `npm ci` here but not in app/) would fail to resolve anything those app files
// imported from node_modules. Pointing nodePaths at our own node_modules resolves
// such deps regardless of the importer's location. This keeps `npm run build`
// self-sufficient and is cross-platform (no NODE_PATH env, which is not portable
// to Windows shells).
import { build } from 'esbuild'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const dir = path.dirname(fileURLToPath(import.meta.url))

await build({
  entryPoints: [path.join(dir, 'src/cli.ts')],
  bundle: true,
  platform: 'node',
  format: 'cjs',
  outfile: path.join(dir, 'dist/cli.js'),
  banner: { js: '#!/usr/bin/env node' },
  nodePaths: [path.join(dir, 'node_modules')],
  // The Claude Agent SDK must NOT be bundled. It is ESM that calls
  // `createRequire(import.meta.url)` at module scope and locates its own bundled CLI relative
  // to its own file; inlining it into a CJS bundle rewrites `import.meta.url` to undefined and
  // the built CLI dies on load with ERR_INVALID_ARG_VALUE before printing usage (verified).
  // Left external, `require()` loads the real package from node_modules — Node >= 22.12
  // supports require() of ESM, which this repo's toolchain already requires.
  external: ['@anthropic-ai/claude-agent-sdk']
})
