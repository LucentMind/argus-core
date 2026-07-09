import { describe, it, expect } from 'vitest'
import { probeAuth } from '../probe'
import { AsyncQueue } from '../asyncQueue'
import type { CreateQueryFn } from '../session'

function fake(messages: unknown[] | 'hang' | 'throw'): CreateQueryFn {
  return () => {
    const q = new AsyncQueue<unknown>()
    if (messages === 'throw') {
      return Object.assign(
        { [Symbol.asyncIterator]: () => ({ next: () => Promise.reject(new Error('spawn claude ENOENT')) }) },
        { interrupt: async () => undefined }
      )
    }
    if (Array.isArray(messages)) for (const m of messages) q.push(m)
    return Object.assign(
      { [Symbol.asyncIterator]: () => q[Symbol.asyncIterator]() },
      { interrupt: async () => q.end() }
    )
  }
}

describe('probeAuth', () => {
  it('reports ok on system/init', async () => {
    const st = await probeAuth(fake([{ type: 'system', subtype: 'init', model: 'claude-sonnet-5' }]))
    expect(st.ok).toBe(true)
    expect(st.detail).toContain('claude-sonnet-5')
  })

  it('times out when nothing arrives', async () => {
    const st = await probeAuth(fake('hang'), { timeoutMs: 50 })
    expect(st.ok).toBe(false)
    expect(st.detail).toMatch(/timed out/i)
  })

  it('reports spawn errors', async () => {
    const st = await probeAuth(fake('throw'))
    expect(st.ok).toBe(false)
    expect(st.detail).toContain('ENOENT')
  })
})
