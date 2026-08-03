import os from 'node:os'
import { describe, it, expect, vi } from 'vitest'
import { createClaudeDriver, type CreateQueryFn } from '..'
import { runClaudeHeadless } from '../headless'

/** A scripted query handle: yields the given SDK messages, then a success result. */
function scriptedQuery(texts: string[]): {
  fn: CreateQueryFn
  interrupts: number
  opts: () => Record<string, unknown>
} {
  let interrupts = 0
  let captured: Record<string, unknown> = {}
  const fn: CreateQueryFn = (args) => {
    captured = args.options
    return {
      async *[Symbol.asyncIterator]() {
        for (const t of texts) {
          yield { type: 'assistant', message: { content: [{ type: 'text', text: t }] } }
        }
        yield { type: 'result', subtype: 'success' }
      },
      interrupt: async () => {
        interrupts++
      }
    }
  }
  return {
    fn,
    get interrupts() {
      return interrupts
    },
    opts: () => captured
  } as never
}

/** A query handle whose iterator never yields, so nothing but the timeout or an abort can
 *  settle the run's race. Counts interrupts, which is how the run reaps the CLI.
 *  Written as a plain object with a hand-rolled `next()` rather than an `async *` generator:
 *  a generator body with no `yield` in it trips eslint's `require-yield`. */
function hangingQuery(): { fn: CreateQueryFn; interrupts: () => number } {
  let interrupts = 0
  const fn: CreateQueryFn = () =>
    ({
      [Symbol.asyncIterator]: () => ({ next: () => new Promise(() => {}) }),
      interrupt: async () => {
        interrupts++
      }
    }) as never
  return { fn, interrupts: () => interrupts }
}

describe('claude runHeadless', () => {
  it('declares the capability and exposes the method', () => {
    const d = createClaudeDriver()
    expect(d.capabilities.headlessOneShot).toBe(true)
    expect(typeof d.runHeadless).toBe('function')
  })

  it('returns the last assistant text and passes the model through', async () => {
    const q = scriptedQuery(['first', 'final answer'])
    const d = createClaudeDriver(q.fn)
    const text = await d.runHeadless!('prompt', {
      argusHome: '/tmp/argus',
      model: 'claude-sonnet-5'
    })
    expect(text).toBe('final answer')
    expect(q.opts()).toMatchObject({ model: 'claude-sonnet-5', maxTurns: 1, allowedTools: [] })
  })

  it('omits model and cliPath when not supplied', async () => {
    const q = scriptedQuery(['ok'])
    const d = createClaudeDriver(q.fn)
    await d.runHeadless!('prompt', { argusHome: '/tmp/argus' })
    expect(q.opts()).not.toHaveProperty('model')
    expect(q.opts()).not.toHaveProperty('pathToClaudeCodeExecutable')
  })

  it('interrupts the query even when the run throws', async () => {
    const q = scriptedQuery([]) // no assistant text -> throws
    const d = createClaudeDriver(q.fn)
    await expect(d.runHeadless!('prompt', { argusHome: '/tmp/argus' })).rejects.toThrow(
      /returned no text/
    )
    expect(q.interrupts).toBe(1)
  })

  it('falls back to resolveCliPath when opts.cliPath is absent (packaged-build escape)', async () => {
    const q = scriptedQuery(['ok'])
    const resolveCliPath = vi.fn(() => '/asar-unpacked/claude.exe')
    const text = await runClaudeHeadless(
      'prompt',
      { argusHome: '/tmp/argus' },
      q.fn,
      resolveCliPath
    )
    expect(text).toBe('ok')
    expect(resolveCliPath).toHaveBeenCalledTimes(1)
    expect(q.opts()).toMatchObject({ pathToClaudeCodeExecutable: '/asar-unpacked/claude.exe' })
  })

  it('prefers opts.cliPath over the resolver fallback, and never calls the resolver', async () => {
    const q = scriptedQuery(['ok'])
    const resolveCliPath = vi.fn(() => '/should-not-be-used')
    await runClaudeHeadless(
      'prompt',
      { argusHome: '/tmp/argus', cliPath: '/user/configured/claude' },
      q.fn,
      resolveCliPath
    )
    expect(resolveCliPath).not.toHaveBeenCalled()
    expect(q.opts()).toMatchObject({ pathToClaudeCodeExecutable: '/user/configured/claude' })
  })

  it('omits pathToClaudeCodeExecutable when both opts.cliPath and the resolver are absent', async () => {
    const q = scriptedQuery(['ok'])
    await runClaudeHeadless('prompt', { argusHome: '/tmp/argus' }, q.fn, () => null)
    expect(q.opts()).not.toHaveProperty('pathToClaudeCodeExecutable')
  })

  it('pins cwd to the OS temp dir — an unset cwd inherits the packaged app cwd ("/" on macOS) and the CLI boot walk triggers TCC prompts attributed to Argus', async () => {
    const q = scriptedQuery(['ok'])
    const d = createClaudeDriver(q.fn)
    await d.runHeadless!('prompt', { argusHome: '/tmp/argus' })
    expect(q.opts()).toMatchObject({ cwd: os.tmpdir() })
  })

  it('rejects when the timeout elapses first', async () => {
    vi.useFakeTimers()
    const fn: CreateQueryFn = () => ({
      // eslint-disable-next-line require-yield
      async *[Symbol.asyncIterator]() {
        await new Promise(() => undefined) // never settles
      },
      interrupt: async () => undefined
    })
    const d = createClaudeDriver(fn)
    const p = d.runHeadless!('prompt', { argusHome: '/tmp/argus', timeoutMs: 1000 })
    const assertion = expect(p).rejects.toThrow(/timed out after 1000ms/)
    await vi.advanceTimersByTimeAsync(1001)
    await assertion
    vi.useRealTimers()
  })

  it('rejects and interrupts when the signal aborts', async () => {
    const q = hangingQuery()
    const d = createClaudeDriver(q.fn)
    const ac = new AbortController()
    const p = d.runHeadless!('prompt', { argusHome: os.tmpdir(), signal: ac.signal })
    ac.abort()
    await expect(p).rejects.toThrow('headless run cancelled')
    expect(q.interrupts()).toBe(1)
  })

  it('rejects immediately when the signal is already aborted', async () => {
    const q = hangingQuery()
    const d = createClaudeDriver(q.fn)
    const ac = new AbortController()
    ac.abort()
    await expect(
      d.runHeadless!('prompt', { argusHome: os.tmpdir(), signal: ac.signal })
    ).rejects.toThrow('headless run cancelled')
  })
})
