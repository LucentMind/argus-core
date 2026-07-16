import { describe, it, expect, afterEach } from 'vitest'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { ExternalAppHost } from '../externalAppHost'
import { createElectronProcessSpawner } from '../electronProcessSpawner'

// panels/__tests__ → up 6 = repo root (same resolution as
// sampleExternalAppPack.load.test.ts, which goes up 6 to reach repo-root/packs).
const PACK_DIR = path.resolve(__dirname, '../../../../../../packs/sample-external-app')
const ENTRY = path.join(PACK_DIR, 'bin', 'app.mjs')
const key = { caseSlug: 'CASE-A', packId: 'sample-external-app', windowId: 'console' }

let host: ExternalAppHost
let logDir: string

afterEach(() => host?.closeAll())

// Bounded poll for real-process-driven state instead of a fixed sleep.
async function waitFor(check: () => boolean, timeoutMs = 5000): Promise<void> {
  const deadline = Date.now() + timeoutMs
  while (!check()) {
    if (Date.now() > deadline) throw new Error('waitFor: condition not met before timeout')
    await new Promise((resolve) => setTimeout(resolve, 20))
  }
}

describe('externalApp integration (3c)', () => {
  it('spawns the sample app, dispatches commands, logs to stderr, and tears down', async () => {
    logDir = fs.mkdtempSync(path.join(os.tmpdir(), 'argus-ext-'))
    host = new ExternalAppHost({
      spawner: createElectronProcessSpawner(),
      logDir,
      dispatchTimeoutMs: 8000
    })

    const info = host.open({
      ...key,
      title: 'Sample',
      entry: ENTRY,
      cwd: PACK_DIR,
      runtime: 'node'
    })
    expect(info.status).toBe('running')

    await expect(host.dispatchToProcess(key, 'ping', [])).resolves.toEqual({
      ok: true,
      result: { pong: true }
    })
    await expect(host.dispatchToProcess(key, 'echo', ['hi'])).resolves.toEqual({
      ok: true,
      result: { echoed: 'hi' }
    })

    // stderr is teed to the per-process log asynchronously (separate pipe from
    // stdout) — poll briefly instead of a fixed sleep to stay deterministic.
    const logFile = path.join(logDir, 'CASE-A_sample-external-app_console.log')
    await waitFor(
      () => fs.existsSync(logFile) && fs.readFileSync(logFile, 'utf8').includes('cmd=ping')
    )
    expect(fs.readFileSync(logFile, 'utf8')).toContain('cmd=ping')

    host.closeAll()
    // Real process teardown is async (SIGTERM -> the child's own exit event),
    // so the host's status flips to 'exited' a tick or two after closeAll()
    // returns. Wait for that real exit before asserting the process-exited
    // dispatch path, rather than racing it.
    await waitFor(
      () => host.list(key.caseSlug).find((a) => a.windowId === key.windowId)?.status === 'exited'
    )
    // after teardown, dispatch reports process-exited (no auto-spawn)
    await expect(host.dispatchToProcess(key, 'ping', [])).resolves.toEqual({
      ok: false,
      reason: 'process-exited',
      hint: 'call mcp__argus__open_panel first'
    })
  })
})
