#!/usr/bin/env node
/**
 * Run the PTC tool-script path against the PACKAGED binary (see ptc/__tests__/packagedSpawn).
 *
 * Why a packaged run and not a unit test: `runToolScript` spawns `process.execPath` with
 * `ELECTRON_RUN_AS_NODE=1`. Under vitest that is plain node, so the existing PTC tests prove the
 * protocol and say nothing about `argus.exe`, where the same call depends on Electron's
 * `runAsNode` fuse. With that fuse off, every tool-script call would boot a second copy of the
 * app instead of running the script — green suite, dead feature. Same shape of blind spot as
 * `smoke:packaged`, which exists because that failure shipped twice.
 *
 * Run after `npm run build:unpack`. Exits non-zero when the build is missing, rather than
 * letting an absent build read as a pass.
 */
import { spawnSync } from 'node:child_process'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const appDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const TEST = 'src/main/services/ptc/__tests__/packagedSpawn.test.ts'

const res = spawnSync('npx', ['vitest', 'run', TEST], {
  cwd: appDir,
  stdio: 'inherit',
  shell: process.platform === 'win32',
  // The test file turns this into a hard error when no packaged build is present.
  env: { ...process.env, ARGUS_REQUIRE_PACKAGED: '1' }
})
process.exit(res.status ?? 1)
