import { describe, it, expect, vi } from 'vitest'
import fs from 'node:fs'
import net from 'node:net'
import * as serverModule from '../server'
import { runToolScript, type PtcRunOpts } from '../run'

const opts = (over: Partial<PtcRunOpts> & Pick<PtcRunOpts, 'script'>): PtcRunOpts => ({
  allowedTools: ['echo'],
  dispatch: async (_t: string, a: Record<string, unknown>) => a,
  maxCalls: 10,
  stdoutCapBytes: 10_000,
  timeoutMs: 15_000,
  ...over
})

describe('runToolScript', () => {
  it('runs a script that calls a tool and returns its stdout', async () => {
    const res = await runToolScript(
      opts({
        script: `const t = require('./argus_tools')
t.echo({ v: 41 }).then((r) => console.log('got', r.v + 1))`
      })
    )
    expect(res.stdout.trim()).toBe('got 42')
    expect(res.exitCode).toBe(0)
    expect(res.calls).toBe(1)
    expect(res.stdoutBytesOmitted).toBe(0)
  })

  it('caps stdout head/tail with honest byte metadata', async () => {
    const res = await runToolScript(
      opts({
        stdoutCapBytes: 1000,
        script: `process.stdout.write('a'.repeat(5000))`
      })
    )
    expect(res.stdoutBytesTotal).toBe(5000)
    expect(res.stdoutBytesOmitted).toBe(4000)
    expect(res.stdout).toContain('bytes omitted')
    expect(Buffer.byteLength(res.stdout)).toBeLessThan(1200) // cap + marker slack
  })

  it('kills a runaway script at timeoutMs', async () => {
    const res = await runToolScript(opts({ timeoutMs: 500, script: `setInterval(() => {}, 1000)` }))
    expect(res.timedOut).toBe(true)
  }, 15_000)

  it('scrubs the child env: no ARGUS_* leakage beyond the PTC pair', async () => {
    process.env.ARGUS_SECRET_TEST = 'leak'
    try {
      const res = await runToolScript(
        opts({
          script: `console.log(JSON.stringify(Object.keys(process.env).filter(k => k.startsWith('ARGUS_')).sort()))`
        })
      )
      expect(JSON.parse(res.stdout.trim())).toEqual(['ARGUS_PTC_PORT', 'ARGUS_PTC_TOKEN'])
    } finally {
      delete process.env.ARGUS_SECRET_TEST
    }
  })

  it('closes the PTC server if temp-dir creation throws, and leaves no lingering state for the next call', async () => {
    const startSpy = vi.spyOn(serverModule, 'startPtcServer')
    const mkdtempSpy = vi.spyOn(fs, 'mkdtempSync').mockImplementationOnce(() => {
      throw new Error('ENOSPC: no space left on device')
    })
    let leakedPort: number
    try {
      await expect(
        runToolScript(opts({ script: `console.log('should never run')` }))
      ).rejects.toThrow('ENOSPC')
      // The server was created (real startPtcServer call-through) before the throw;
      // capture its port so we can prove below that it was actually closed, not leaked.
      expect(startSpy.mock.results).toHaveLength(1)
      leakedPort = (await startSpy.mock.results[0].value).port
    } finally {
      mkdtempSpy.mockRestore()
      startSpy.mockRestore()
    }

    // A listening server would still accept this connection; a closed one refuses it.
    // This is the real regression check — a follow-up call succeeding on its own proves
    // nothing, since every call gets an independent OS-assigned port either way.
    await expect(
      new Promise((resolve, reject) => {
        const sock = net.connect({ host: '127.0.0.1', port: leakedPort }, () => {
          sock.destroy()
          resolve(undefined)
        })
        sock.on('error', reject)
      })
    ).rejects.toThrow(/ECONNREFUSED/)

    // A normal call right after the failed one must still succeed too: no lingering
    // state (e.g. a stuck listener/handle) from the failed attempt should affect it.
    const res = await runToolScript(
      opts({
        script: `const t = require('./argus_tools')
t.echo({ v: 1 }).then((r) => console.log('ok', r.v))`
      })
    )
    expect(res.stdout.trim()).toBe('ok 1')
    expect(res.exitCode).toBe(0)
  })
})
