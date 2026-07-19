import { describe, it, expect, vi } from 'vitest'
import { createClaudeDriver, type CreateQueryFn } from '..'

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
})
