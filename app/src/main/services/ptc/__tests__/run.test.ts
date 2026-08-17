import { describe, it, expect } from 'vitest'
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
})
