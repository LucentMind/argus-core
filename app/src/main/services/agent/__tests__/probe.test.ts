import { describe, it, expect } from 'vitest'
import { probeAuth } from '../probe'
import { AsyncQueue } from '../asyncQueue'
import type { CreateQueryFn } from '../session'

function fake(messages: unknown[] | 'hang' | 'throw'): CreateQueryFn {
  return (args) => {
    const q = new AsyncQueue<unknown>()
    if (messages === 'throw') {
      return Object.assign(
        {
          [Symbol.asyncIterator]: () => ({
            next: () => Promise.reject(new Error('spawn claude ENOENT'))
          })
        },
        { interrupt: async () => undefined }
      )
    }
    if (Array.isArray(messages)) {
      // mimic the real CLI: init and everything after it are only emitted once
      // the prompt stream yields a first user message
      void (async () => {
        await args.prompt[Symbol.asyncIterator]().next()
        for (const m of messages) q.push(m)
      })()
    }
    return Object.assign(
      { [Symbol.asyncIterator]: () => q[Symbol.asyncIterator]() },
      { interrupt: async () => q.end() }
    )
  }
}

describe('probeAuth', () => {
  it('reports ok on system/init', async () => {
    const st = await probeAuth(
      fake([{ type: 'system', subtype: 'init', model: 'claude-sonnet-5' }])
    )
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

  it('extracts email, subscription label, and version from an init message carrying an account', async () => {
    const st = await probeAuth(
      fake([
        {
          type: 'system',
          subtype: 'init',
          model: 'claude-sonnet-5',
          version: '2.1.204',
          account: { email: 'dev@example.com', subscriptionType: 'max20x' }
        }
      ])
    )
    expect(st.ok).toBe(true)
    expect(st.email).toBe('dev@example.com')
    expect(st.subscription).toBe('Claude Max Subscription')
    expect(st.version).toBe('2.1.204')
  })

  it('tolerates an init message with no account or version (older CLIs) — new fields stay undefined', async () => {
    const st = await probeAuth(
      fake([{ type: 'system', subtype: 'init', model: 'claude-sonnet-5' }])
    )
    expect(st.ok).toBe(true)
    expect(st.email).toBeUndefined()
    expect(st.subscription).toBeUndefined()
    expect(st.version).toBeUndefined()
  })

  it('maps subscription prefixes and apiKey token source per the label table', async () => {
    const pro = await probeAuth(
      fake([{ type: 'system', subtype: 'init', account: { subscriptionType: 'pro' } }])
    )
    expect(pro.subscription).toBe('Claude Pro Subscription')

    const team = await probeAuth(
      fake([{ type: 'system', subtype: 'init', account: { subscriptionType: 'team_standard' } }])
    )
    expect(team.subscription).toBe('Claude Team Subscription')

    const enterprise = await probeAuth(
      fake([{ type: 'system', subtype: 'init', account: { subscriptionType: 'enterprise' } }])
    )
    expect(enterprise.subscription).toBe('Claude Enterprise')

    const apiKey = await probeAuth(
      fake([
        {
          type: 'system',
          subtype: 'init',
          account: { subscriptionType: 'max', tokenSource: 'apiKey' }
        }
      ])
    )
    expect(apiKey.subscription).toBe('API key')

    const other = await probeAuth(
      fake([{ type: 'system', subtype: 'init', account: { subscriptionType: 'free_tier' } }])
    )
    expect(other.subscription).toBe('Free Tier')
  })
})
