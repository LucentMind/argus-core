// Build the argus-pack CLI into dist/cli.js.
//
// Uses esbuild's JS API (not the CLI) so we can set `nodePaths` explicitly:
// the bundle follows an import into ../../app/src/main/services/packs/manifest.ts,
// which does `import { z } from 'zod'`. esbuild resolves that relative to the
// importer (under app/), so a checkout that installs only this package's deps
// (e.g. CI, which runs `npm ci` here but not in app/) would fail to resolve zod.
// zod is a declared dependency of THIS package, so point nodePaths at our own
// node_modules to resolve it regardless of the importer's location. This keeps
// `npm run build` self-sufficient and is cross-platform (no NODE_PATH env, which
// is not portable to Windows shells).
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
  nodePaths: [path.join(dir, 'node_modules')]
})
