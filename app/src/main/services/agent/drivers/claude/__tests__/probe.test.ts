import os from 'node:os'
import { describe, it, expect } from 'vitest'
import { probeAuth } from '../probe'
import { agentScratchCwd } from '../../../scratchCwd'
import { AsyncQueue } from '../../../asyncQueue'
import type { CreateQueryFn } from '../index'

type Account = { email?: string; subscriptionType?: string; tokenSource?: string }
type InitResponse = { account?: Account; claude_code_version?: string }

/**
 * Mirrors the real SDK handle as measured live (2026-11-10, @anthropic-ai/claude-agent-sdk
 * 0.3.299): the message stream NEVER emits `system/init` unless the prompt stream yields a user
 * message — and a user message is a full billed turn — while `initializationResult()` resolves
 * from the control channel ~0.7s after spawn with the account and `claude_code_version`,
 * without any `/v1/messages` request. So the stream here never yields; only the control
 * channel answers.
 *
 *  - an `InitResponse` resolves `initializationResult()` with it
 *  - `'hang'`: the CLI never answers (wedged / still booting past the budget)
 *  - `'throw'`: the stream rejects the way a failed spawn does
 *  - `'exit'`: the stream ends with no init (the CLI died at boot)
 */
function fake(
  init: InitResponse | 'hang' | 'throw' | 'exit',
  opts: { onClose?: () => void; onInterrupt?: () => void } = {}
): CreateQueryFn {
  return () => {
    const q = new AsyncQueue<unknown>()
    if (init === 'exit') q.end()
    const stream =
      init === 'throw'
        ? {
            [Symbol.asyncIterator]: () => ({
              next: () => Promise.reject(new Error('spawn claude ENOENT'))
            })
          }
        : { [Symbol.asyncIterator]: () => q[Symbol.asyncIterator]() }
    return Object.assign(stream, {
      initializationResult: () =>
        typeof init === 'object' ? Promise.resolve(init) : new Promise<never>(() => undefined),
      interrupt: async () => {
        opts.onInterrupt?.()
        q.end()
      },
      close: () => {
        opts.onClose?.()
        q.end()
      }
    })
  }
}

const READY: InitResponse = { claude_code_version: '2.1.299' }

describe('probeAuth', () => {
  it('reports ok from initializationResult() alone — the stream never carries system/init without a user message', async () => {
    const st = await probeAuth(fake(READY))
    expect(st.ok).toBe(true)
    expect(st.detail).toContain('claude ready')
  })

  // The old probe yielded a literal "ping" user message with `maxTurns: 0`, believing that
  // triggered init without a turn. The SDK forwards maxTurns as `if (maxTurns) …`, so 0 was
  // dropped and the CLI ran an unlimited turn: 1,935 billed "pong" replies (~30K cached input
  // tokens each) were found in the probe's scratch-cwd transcripts on one machine. The only
  // probe that is free is one that never sends a user message at all.
  it('never yields a user message — any user message is a billed turn', async () => {
    let prompt: AsyncIterable<unknown> | undefined
    const spy: CreateQueryFn = (args) => {
      prompt = args.prompt as AsyncIterable<unknown>
      return fake(READY)(args)
    }
    await probeAuth(spy)
    expect(prompt).toBeDefined()
    const first = await Promise.race([
      prompt!
        [Symbol.asyncIterator]()
        .next()
        .then((r) => (r.done ? 'ended' : 'yielded')),
      new Promise<'silent'>((r) => setTimeout(() => r('silent'), 50))
    ])
    expect(first).toBe('silent')
  })

  it('passes no maxTurns — the SDK drops 0 as falsy, which is exactly how the ping became a full turn', async () => {
    let captured: Record<string, unknown> | undefined
    const spy: CreateQueryFn = (args) => {
      captured = args.options as Record<string, unknown>
      return fake(READY)(args)
    }
    await probeAuth(spy)
    expect(captured).toBeDefined()
    expect('maxTurns' in captured!).toBe(false)
  })

  it('times out when the CLI never answers', async () => {
    const st = await probeAuth(fake('hang'), { timeoutMs: 50 })
    expect(st.ok).toBe(false)
    expect(st.detail).toMatch(/timed out/i)
  })

  it('reports spawn errors', async () => {
    const st = await probeAuth(fake('throw'))
    expect(st.ok).toBe(false)
    expect(st.detail).toContain('ENOENT')
  })

  it('reports a CLI that exits before initializing', async () => {
    const st = await probeAuth(fake('exit'), { timeoutMs: 500 })
    expect(st.ok).toBe(false)
    expect(st.detail).toMatch(/exited before initializing/i)
  })

  it('extracts email, subscription label and version from the initialize response', async () => {
    const st = await probeAuth(
      fake({
        claude_code_version: '2.1.205',
        account: { email: 'dev@example.com', subscriptionType: 'max20x' }
      })
    )
    expect(st.ok).toBe(true)
    expect(st.email).toBe('dev@example.com')
    expect(st.subscription).toBe('Claude Max Subscription')
    expect(st.version).toBe('2.1.205')
    expect(st.detail).toBe('claude ready (Claude Code 2.1.205)')
  })

  it('tolerates an initialize response with no account or version (older CLIs) — fields stay undefined', async () => {
    const st = await probeAuth(fake({}))
    expect(st.ok).toBe(true)
    expect(st.email).toBeUndefined()
    expect(st.subscription).toBeUndefined()
    expect(st.version).toBeUndefined()
    expect(st.detail).toBe('claude ready')
  })

  it('maps subscription prefixes and apiKey token source per the label table', async () => {
    const label = async (account: Account): Promise<string | undefined> =>
      (await probeAuth(fake({ account }))).subscription
    expect(await label({ subscriptionType: 'pro' })).toBe('Claude Pro Subscription')
    expect(await label({ subscriptionType: 'team_standard' })).toBe('Claude Team Subscription')
    expect(await label({ subscriptionType: 'enterprise' })).toBe('Claude Enterprise')
    expect(await label({ subscriptionType: 'max', tokenSource: 'apiKey' })).toBe('API key')
    expect(await label({ subscriptionType: 'free_tier' })).toBe('Free Tier')
  })

  it('passes pathToClaudeCodeExecutable through to the query options when cliPath is configured', async () => {
    let captured: Record<string, unknown> | undefined
    const spy: CreateQueryFn = (args) => {
      captured = args.options as Record<string, unknown>
      return fake(READY)(args)
    }
    await probeAuth(spy, { cliPath: '/usr/local/bin/claude' })
    expect(captured?.pathToClaudeCodeExecutable).toBe('/usr/local/bin/claude')
  })

  it('omits pathToClaudeCodeExecutable when no cliPath is configured', async () => {
    let captured: Record<string, unknown> | undefined
    const spy: CreateQueryFn = (args) => {
      captured = args.options as Record<string, unknown>
      return fake(READY)(args)
    }
    await probeAuth(spy)
    expect(captured?.pathToClaudeCodeExecutable).toBeUndefined()
  })

  it('pins cwd to an empty scratch dir, not the temp root — an unset cwd inherits the packaged app cwd ("/" on macOS) and trips TCC, but the temp root itself made the CLI boot walk take 6–17s against a 10s budget', async () => {
    let captured: Record<string, unknown> | undefined
    const spy: CreateQueryFn = (args) => {
      captured = args.options as Record<string, unknown>
      return fake(READY)(args)
    }
    await probeAuth(spy)
    expect(captured?.cwd).toBe(agentScratchCwd())
    expect(captured?.cwd).not.toBe(os.tmpdir())
  })

  it('closes the handle afterwards so the idle CLI does not linger waiting for a prompt', async () => {
    let closed = 0
    await probeAuth(fake(READY, { onClose: () => closed++ }))
    expect(closed).toBe(1)
  })

  it('falls back to interrupt() on a handle without close()', async () => {
    let interrupted = 0
    const noClose: CreateQueryFn = (args) => {
      const h = fake(READY, { onInterrupt: () => interrupted++ })(args) as unknown as {
        close?: unknown
      }
      delete h.close
      return h as ReturnType<CreateQueryFn>
    }
    await probeAuth(noClose)
    expect(interrupted).toBe(1)
  })

  it('a successful initialize reports verified:false — init proves the CLI booted, not that credentials work', async () => {
    const st = await probeAuth(fake(READY))
    expect(st.ok).toBe(true)
    expect(st.verified).toBe(false)
  })

  it('a probe failure is also unverified', async () => {
    const st = await probeAuth(fake('throw'))
    expect(st.ok).toBe(false)
    expect(st.verified).toBe(false)
  })
})
