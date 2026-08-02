#!/usr/bin/env node
/**
 * Builds the Rust resource-monitor sidecar and stages it where electron-builder's
 * extraResources entry expects it.
 *
 * Deliberately NOT wired into `npm run build`: a checkout without a Rust
 * toolchain must still typecheck, test and build the app. The app degrades to
 * Electron-metrics-only when the binary is absent.
 *
 * macOS builds both arches and lipo-merges them so one bundle covers Intel and
 * Apple Silicon. Linux is out of scope.
 */
import { execFileSync } from 'node:child_process'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const appDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const repoRoot = path.resolve(appDir, '..')
const manifest = path.join(repoRoot, 'native', 'resource-monitor', 'Cargo.toml')
const exeName =
  process.platform === 'win32' ? 'argus-resource-monitor.exe' : 'argus-resource-monitor'

const TARGETS = {
  win32: ['x86_64-pc-windows-msvc'],
  darwin: ['aarch64-apple-darwin', 'x86_64-apple-darwin']
}

const targets = TARGETS[process.platform]
if (!targets) {
  console.error(`[resource-monitor] unsupported platform ${process.platform}; skipping`)
  process.exit(0)
}

const run = (cmd, args) => {
  console.log(`[resource-monitor] ${cmd} ${args.join(' ')}`)
  execFileSync(cmd, args, { stdio: 'inherit', cwd: repoRoot })
}

for (const target of targets) {
  run('rustup', ['target', 'add', target])
  run('cargo', ['build', '--locked', '--release', '--manifest-path', manifest, '--target', target])
}

// Must match the archKey computed in app/src/main/services/diagnostics/sidecarBinary.ts
// (resolveSidecarBinary) — a mismatch here silently leaves the app in degraded mode.
const archKey = process.platform === 'win32' ? 'win32-x64' : 'darwin-universal'
const outDir = path.join(appDir, 'resources', 'resource-monitor', archKey)
fs.mkdirSync(outDir, { recursive: true })
const dest = path.join(outDir, exeName)
const built = (t) =>
  path.join(repoRoot, 'native', 'resource-monitor', 'target', t, 'release', exeName)

if (process.platform === 'darwin') {
  run('lipo', ['-create', '-output', dest, built(targets[0]), built(targets[1])])
} else {
  fs.copyFileSync(built(targets[0]), dest)
}
if (process.platform !== 'win32') fs.chmodSync(dest, 0o755)

const { size } = fs.statSync(dest)
console.log(`[resource-monitor] staged ${dest} (${(size / 1024 / 1024).toFixed(1)} MB)`)
