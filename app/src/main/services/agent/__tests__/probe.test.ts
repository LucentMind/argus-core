import { describe, it, expect } from 'vitest'
import { probeAuth } from '../probe'
import { AsyncQueue } from '../asyncQueue'
import type { CreateQueryFn } from '../session'

function fake(
  messages: unknown[] | 'hang' | 'throw',
  opts: { initializationResult?: () => Promise<unknown> } = {}
): CreateQueryFn {
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
      { interrupt: async () => q.end() },
      opts.initializationResult ? { initializationResult: opts.initializationResult } : {}
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

  it('extracts email, subscription label, and version via initializationResult() (real SDK shape: init message carries no account)', async () => {
    const st = await probeAuth(
      fake(
        [
          {
            type: 'system',
            subtype: 'init',
            model: 'claude-sonnet-5',
            claude_code_version: '2.1.205'
            // no `account` here — verified against the real SDK, account never
            // rides on the init message; it comes from initializationResult()
          }
        ],
        {
          initializationResult: async () => ({
            account: { email: 'dev@example.com', subscriptionType: 'max20x' }
          })
        }
      )
    )
    expect(st.ok).toBe(true)
    expect(st.email).toBe('dev@example.com')
    expect(st.subscription).toBe('Claude Max Subscription')
    expect(st.version).toBe('2.1.205')
  })

  it('falls back to an account carried directly on the init message when the handle has no initializationResult()', async () => {
    const st = await probeAuth(
      fake([
        {
          type: 'system',
          subtype: 'init',
          model: 'claude-sonnet-5',
          version: '2.1.204',
          account: { email: 'dev@example.com', subscriptionType: 'pro' }
        }
      ])
    )
    expect(st.ok).toBe(true)
    expect(st.email).toBe('dev@example.com')
    expect(st.subscription).toBe('Claude Pro Subscription')
    expect(st.version).toBe('2.1.204')
  })

  it('tolerates an init message with no account or version and no initializationResult() (older CLIs) — new fields stay undefined', async () => {
    const st = await probeAuth(
      fake([{ type: 'system', subtype: 'init', model: 'claude-sonnet-5' }])
    )
    expect(st.ok).toBe(true)
    expect(st.email).toBeUndefined()
    expect(st.subscription).toBeUndefined()
    expect(st.version).toBeUndefined()
  })

  it('ignores an initializationResult() that resolves without an account (ok-detection unaffected)', async () => {
    const st = await probeAuth(
      fake([{ type: 'system', subtype: 'init', model: 'claude-sonnet-5' }], {
        initializationResult: async () => ({})
      })
    )
    expect(st.ok).toBe(true)
    expect(st.email).toBeUndefined()
    expect(st.subscription).toBeUndefined()
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

  it('passes pathToClaudeCodeExecutable through to the query options when cliPath is configured', async () => {
    let captured: Record<string, unknown> | undefined
    const spy: CreateQueryFn = (args) => {
      captured = args.options as Record<string, unknown>
      return fake([{ type: 'system', subtype: 'init', model: 'claude-sonnet-5' }])(args)
    }
    await probeAuth(spy, { cliPath: '/usr/local/bin/claude' })
    expect(captured?.pathToClaudeCodeExecutable).toBe('/usr/local/bin/claude')
  })

  it('omits pathToClaudeCodeExecutable when no cliPath is configured', async () => {
    let captured: Record<string, unknown> | undefined
    const spy: CreateQueryFn = (args) => {
      captured = args.options as Record<string, unknown>
      return fake([{ type: 'system', subtype: 'init', model: 'claude-sonnet-5' }])(args)
    }
    await probeAuth(spy)
    expect(captured?.pathToClaudeCodeExecutable).toBeUndefined()
  })

  it('a successful init reports verified:false — init proves the CLI booted, not that credentials work', async () => {
    const st = await probeAuth(
      fake([{ type: 'system', subtype: 'init', model: 'claude-sonnet-5' }])
    )
    expect(st.ok).toBe(true)
    expect(st.verified).toBe(false)
  })

  it('a probe failure is also unverified', async () => {
    const st = await probeAuth(fake('throw'))
    expect(st.ok).toBe(false)
    expect(st.verified).toBe(false)
  })
})
