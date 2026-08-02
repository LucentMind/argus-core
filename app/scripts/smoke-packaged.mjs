#!/usr/bin/env node
/**
 * Run the packaged app's provider smoke check (see services/agent/smokeProviders.ts).
 *
 * Why a packaged run and not a unit test: the failure this guards against — a CLI binary
 * resolving to a path inside `app.asar`, which cannot be spawned — does not exist until the
 * app is packaged. The unit suite is green while the shipped app is dead, which is exactly how
 * it shipped twice (Copilot, then Claude). Run after `npm run build:unpack`.
 *
 * Exits 0 when every driver's binary launched, 1 otherwise. Authentication is not required:
 * "not authenticated" proves the process ran and answered, which is the whole assertion.
 */
import { spawnSync } from 'node:child_process'
import { existsSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const appDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')

// The unpacked build's executable, per platform. electron-builder emits mac-arm64/ on Apple
// silicon and mac/ on Intel, so both are candidates.
const dist = path.join(appDir, 'dist')
const CANDIDATES = {
  win32: [path.join(dist, 'win-unpacked', 'argus.exe')],
  darwin: [
    path.join(dist, 'mac-arm64', 'Argus.app', 'Contents', 'MacOS', 'Argus'),
    path.join(dist, 'mac', 'Argus.app', 'Contents', 'MacOS', 'Argus')
  ],
  linux: [path.join(dist, 'linux-unpacked', 'argus')]
}

const binary = (CANDIDATES[process.platform] ?? []).find((p) => existsSync(p)) ?? null
if (!binary) {
  console.error(
    `No unpacked build found for ${process.platform}. Run \`npm run build:unpack\` first.`
  )
  process.exit(1)
}

console.log(`smoke: ${binary}`)
// Hard timeout: a build that predates the --smoke-providers flag ignores it and boots the
// GUI instead, which would hang CI forever. Treat "still running" as a failure, not a pass.
const TIMEOUT_MS = 180_000
const res = spawnSync(binary, ['--smoke-providers'], {
  stdio: 'inherit',
  timeout: TIMEOUT_MS,
  killSignal: 'SIGKILL',
  // A scratch ARGUS_HOME keeps the smoke run from reading or writing real user data.
  env: {
    ...process.env,
    ARGUS_HOME: path.join(appDir, 'dist', '.smoke-home'),
    ELECTRON_DISABLE_SECURITY_WARNINGS: '1'
  }
})

if (res.error) {
  const hint =
    res.error.code === 'ETIMEDOUT'
      ? ` — it never exited within ${TIMEOUT_MS / 1000}s. Does this build predate --smoke-providers?`
      : ''
  console.error(`smoke: could not run the packaged app: ${res.error.message}${hint}`)
  process.exit(1)
}
if (res.status !== 0) {
  console.error(
    `smoke: FAILED — at least one provider CLI could not be launched from the packaged build.`
  )
  process.exit(1)
}

// The sidecar ships via extraResources, so it lives beside the asar rather than inside
// it. Spawn it — do not merely stat it. A binary that passes existsSync but cannot
// actually launch is precisely how this project shipped two dead CLIs.
const resourcesDir =
  process.platform === 'darwin'
    ? path.join(binary, '..', '..', 'Resources')
    : path.join(path.dirname(binary), 'resources')
const sidecar = path.join(
  resourcesDir,
  'resource-monitor',
  process.platform === 'win32' ? 'win32-x64' : 'darwin-universal',
  process.platform === 'win32' ? 'argus-resource-monitor.exe' : 'argus-resource-monitor'
)

if (!existsSync(sidecar)) {
  console.error(`smoke: FAILED — resource-monitor sidecar missing at ${sidecar}`)
  process.exit(1)
}

// Closing stdin makes the sidecar's reader thread see EOF and exit, so this terminates
// on its own. The 5s timeout is the backstop for a binary that ignores it.
const mon = spawnSync(sidecar, [], { timeout: 5_000, killSignal: 'SIGKILL', input: '' })
const helloLine = String(mon.stdout ?? '')
  .split('\n')
  .find((l) => l.includes('"type":"hello"'))
if (!helloLine) {
  console.error(
    `smoke: FAILED — sidecar produced no hello handshake. stderr: ${String(mon.stderr ?? '').slice(0, 400)}`
  )
  process.exit(1)
}
console.log(`smoke: resource-monitor sidecar handshook — ${helloLine.trim()}`)

console.log('smoke: every provider CLI launched')
