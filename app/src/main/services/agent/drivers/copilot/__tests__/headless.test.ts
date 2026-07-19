import { describe, it, expect } from 'vitest'
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
})
