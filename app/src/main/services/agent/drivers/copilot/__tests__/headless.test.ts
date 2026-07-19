import { describe, it, expect, vi } from 'vitest'
import os from 'node:os'
import path from 'node:path'
import { runCopilotHeadless, headlessScratchDir } from '../headless'
import type { CopilotClientFactory, CopilotSessionLike } from '../client'
import type { RawSdkEvent } from '../normalize'

/** Scripted client: replays `events` to the session subscriber on send(). */
function fakeFactory(events: RawSdkEvent[]): {
  factory: CopilotClientFactory
  calls: { stops: number; forceStops: number; opts: Record<string, unknown> }
} {
  const calls = { stops: 0, forceStops: 0, opts: {} as Record<string, unknown> }
  const factory: CopilotClientFactory = (opts) => {
    calls.opts = opts as unknown as Record<string, unknown>
    return {
      start: async () => undefined,
      getAuthStatus: async () => ({ isAuthenticated: true }),
      getStatus: async () => ({}),
      stop: async () => {
        calls.stops++
        return []
      },
      forceStop: async () => {
        calls.forceStops++
      },
      resumeSession: async () => {
        throw new Error('not used')
      },
      createSession: async () => {
        let handler: ((e: RawSdkEvent) => void) | null = null
        const session: CopilotSessionLike = {
          sessionId: 'headless-1',
          on: (h) => {
            handler = h
            return () => {
              handler = null
            }
          },
          send: async () => {
            for (const e of events) handler?.(e)
            return 'ok'
          },
          abort: async () => undefined
        }
        return session
      }
    }
  }
  return { factory, calls }
}

const msg = (content: string): RawSdkEvent =>
  ({ type: 'assistant.message', data: { content } }) as RawSdkEvent
const turnEnd = { type: 'assistant.turn_end', data: {} } as RawSdkEvent

/** Scripted client whose session `send()` resolves but never emits `assistant.turn_end` or
 *  `session.error` — models a wedged/hung turn so the timeout branch is the only way the
 *  race can settle. Exposes whether the driver ever unsubscribed the `session.on` listener,
 *  which is the one thing the abandoned-promise timeout path can silently skip. */
function hangFactory(): {
  factory: CopilotClientFactory
  calls: { stops: number; forceStops: number }
  unsubscribed: () => boolean
} {
  const calls = { stops: 0, forceStops: 0 }
  let unsubscribed = false
  const factory: CopilotClientFactory = () => ({
    start: async () => undefined,
    getAuthStatus: async () => ({ isAuthenticated: true }),
    getStatus: async () => ({}),
    stop: async () => {
      calls.stops++
      return []
    },
    forceStop: async () => {
      calls.forceStops++
    },
    resumeSession: async () => {
      throw new Error('not used')
    },
    createSession: async () => {
      const session: CopilotSessionLike = {
        sessionId: 'headless-hang',
        on: () => () => {
          unsubscribed = true
        },
        send: async () => 'ok', // resolves, but the turn never produces an end/error event
        abort: async () => undefined
      }
      return session
    }
  })
  return { factory, calls, unsubscribed: () => unsubscribed }
}

/** Scripted client whose `start()` never resolves — models a wedged transport handshake.
 *  `createSession` must never be reached: a fixed start() should trip the timeout before
 *  the code ever gets there. */
function hangOnStartFactory(): {
  factory: CopilotClientFactory
  calls: { stops: number; forceStops: number; createSessionCalls: number }
} {
  const calls = { stops: 0, forceStops: 0, createSessionCalls: 0 }
  const factory: CopilotClientFactory = () => ({
    start: () => new Promise(() => undefined), // never resolves
    getAuthStatus: async () => ({ isAuthenticated: true }),
    getStatus: async () => ({}),
    stop: async () => {
      calls.stops++
      return []
    },
    forceStop: async () => {
      calls.forceStops++
    },
    resumeSession: async () => {
      throw new Error('not used')
    },
    createSession: async () => {
      calls.createSessionCalls++
      throw new Error('should not be reached while start() is wedged')
    }
  })
  return { factory, calls }
}

describe('runCopilotHeadless', () => {
  it('returns the final assistant message and stops the client', async () => {
    const { factory, calls } = fakeFactory([msg('partial'), msg('final answer'), turnEnd])
    const text = await runCopilotHeadless('prompt', { argusHome: '/tmp/argus' }, factory)
    expect(text).toBe('final answer')
    expect(calls.stops).toBe(1)
  })

  it('roots the run in the scratch dir, never a case dir', async () => {
    const { factory, calls } = fakeFactory([msg('ok'), turnEnd])
    const home = path.join(os.tmpdir(), 'argus-headless-test')
    await runCopilotHeadless('prompt', { argusHome: home }, factory)
    expect(calls.opts.workingDirectory).toBe(headlessScratchDir(home))
  })

  it('rejects on session.error and still stops the client', async () => {
    const { factory, calls } = fakeFactory([
      { type: 'session.error', data: { message: 'not authenticated' } } as RawSdkEvent
    ])
    await expect(
      runCopilotHeadless('prompt', { argusHome: '/tmp/argus' }, factory)
    ).rejects.toThrow(/not authenticated/)
    expect(calls.stops).toBe(1)
  })

  it('throws when the turn ends with no assistant text', async () => {
    const { factory } = fakeFactory([turnEnd])
    await expect(
      runCopilotHeadless('prompt', { argusHome: '/tmp/argus' }, factory)
    ).rejects.toThrow(/returned no text/)
  })

  it('unsubscribes the listener and stops the client when the run times out', async () => {
    const { factory, calls, unsubscribed } = hangFactory()
    await expect(
      runCopilotHeadless('prompt', { argusHome: '/tmp/argus', timeoutMs: 20 }, factory)
    ).rejects.toThrow(/timed out/)
    expect(calls.stops).toBe(1)
    // The pinning assertion: a timeout must not leave the session.on listener attached.
    expect(unsubscribed()).toBe(true)
  })

  it('times out when start() never resolves, instead of hanging forever', async () => {
    vi.useFakeTimers()
    try {
      const { factory, calls } = hangOnStartFactory()
      const p = runCopilotHeadless('prompt', { argusHome: '/tmp/argus', timeoutMs: 1000 }, factory)
      const assertion = expect(p).rejects.toThrow(/timed out after 1000ms/)
      await vi.advanceTimersByTimeAsync(1001)
      await assertion
      expect(calls.stops).toBe(1)
      expect(calls.createSessionCalls).toBe(0)
    } finally {
      vi.useRealTimers()
    }
  })
})
