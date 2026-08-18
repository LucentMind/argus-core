import { describe, it, expect } from 'vitest'
import fs from 'node:fs'
import path from 'node:path'
import { runToolScript } from '../run'

/**
 * The one PTC assertion the rest of the suite structurally cannot make.
 *
 * `runToolScript` spawns `process.execPath` with `ELECTRON_RUN_AS_NODE=1`. Under vitest,
 * `process.execPath` is plain node — so every other test in this directory proves the protocol
 * works under node and says nothing about the binary users actually run. In a packaged app that
 * same call spawns `argus.exe`, and whether it behaves as node depends on Electron's `runAsNode`
 * fuse. If that fuse were ever flipped off (electron-builder can do it, and a future hardening
 * change is exactly the sort of thing that would), each tool-script call would launch a SECOND
 * COPY OF ARGUS instead of running the script — a failure with no unit-test-visible symptom.
 *
 * Runs against the real server, the real generated stub and the real env scrub; only the runtime
 * is redirected, through the `nodeBin` seam, to the packaged binary. Requires `npm run
 * build:unpack` first; use `npm run smoke:ptc-packaged`, which fails rather than skips when the
 * build is absent.
 */

const dist = path.resolve(__dirname, '../../../../../dist')
const CANDIDATES: Record<string, string[]> = {
  win32: [path.join(dist, 'win-unpacked', 'argus.exe')],
  darwin: [
    path.join(dist, 'mac-arm64', 'Argus.app', 'Contents', 'MacOS', 'Argus'),
    path.join(dist, 'mac', 'Argus.app', 'Contents', 'MacOS', 'Argus')
  ],
  linux: [path.join(dist, 'linux-unpacked', 'argus')]
}

const binary = (CANDIDATES[process.platform] ?? []).find((p) => fs.existsSync(p)) ?? null

// Absent build: skipped in an ordinary `npm test`, but a hard failure under the smoke script, so
// "no packaged build" can never be mistaken for "the packaged path passed".
if (!binary && process.env.ARGUS_REQUIRE_PACKAGED === '1') {
  throw new Error(
    `No unpacked build found for ${process.platform}. Run \`npm run build:unpack\` first.`
  )
}

describe.skipIf(!binary)('runToolScript against the packaged binary', () => {
  it('runs the script as node and completes a loopback tool call', async () => {
    const res = await runToolScript({
      script: `const t = require('./argus_tools')
// Printed, not assumed: this is what distinguishes "the packaged Electron binary ran the
// script as node" from "something on PATH called node ran it". Electron keeps
// process.versions.electron populated under ELECTRON_RUN_AS_NODE; plain node has no such key.
console.log('electron', process.versions.electron || 'NONE')
t.echo({ v: 41 }).then((r) => console.log('got', r.v + 1))`,
      allowedTools: ['echo'],
      dispatch: async (_tool, args) => args,
      maxCalls: 10,
      stdoutCapBytes: 10_000,
      // Short on purpose: the fuse-disabled failure mode is a GUI that never exits, and a
      // 10-minute hang is a worse test result than a fast red.
      timeoutMs: 60_000,
      nodeBin: binary!
    })

    // A booted GUI would produce none of these.
    expect(res.stdout).toMatch(/^electron \d+\./m)
    expect(res.stdout).toContain('got 42')
    expect(res.calls).toBe(1)
    expect(res.timedOut).toBe(false)
    expect(res.exitCode).toBe(0)
  }, 70_000)

  it('reports a script failure as a non-zero exit rather than hanging', async () => {
    const res = await runToolScript({
      script: `throw new Error('boom')`,
      allowedTools: [],
      dispatch: async () => ({}),
      maxCalls: 1,
      stdoutCapBytes: 10_000,
      timeoutMs: 60_000,
      nodeBin: binary!
    })
    expect(res.timedOut).toBe(false)
    expect(res.exitCode).not.toBe(0)
    expect(res.stdout).toContain('boom')
  }, 70_000)
})
