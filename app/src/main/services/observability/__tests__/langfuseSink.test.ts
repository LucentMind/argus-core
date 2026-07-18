import { describe, it, expect } from 'vitest'
import { LangfuseSink, synthSpanId, type TracingApi, type ObservationHandle } from '../langfuseSink'

function fakeTracing(): {
  api: TracingApi
  calls: Record<string, unknown[]>
  resolveIds: () => void
} {
  const calls: Record<string, unknown[]> = { start: [], score: [], flush: [], shutdown: [] }
  const releases: Array<() => void> = []
  const api: TracingApi = {
    createTraceId: (seed) => new Promise((res) => releases.push(() => res(`trace-${seed}`))),
    startObservation: (name, attrs, opts) => {
      calls.start.push({ name, attrs, opts })
      const handle: ObservationHandle = {
        spanId: `span-for-${name}`,
        end: () => {}
      }
      return handle
    },
    createScore: async (o) => {
      calls.score.push(o)
    },
    forceFlush: async () => {
      calls.flush.push(1)
    },
    shutdown: async () => {
      calls.shutdown.push(1)
    }
  }
  return { api, calls, resolveIds: () => releases.splice(0).forEach((r) => r()) }
}

const rootIntent = {
  kind: 'trace-root' as const,
  seed: 'argus-session-7',
  name: 'auth-bug · session 7',
  metadata: { caseId: 1 }
}

describe('synthSpanId', () => {
  it('is deterministic and 16 lowercase hex chars', () => {
    const a = synthSpanId('argus-session-7')
    expect(a).toBe(synthSpanId('argus-session-7'))
    expect(a).toMatch(/^[0-9a-f]{16}$/)
  })

  it('differs across seeds', () => {
    expect(synthSpanId('argus-session-7')).not.toBe(synthSpanId('argus-session-8'))
  })
})

describe('LangfuseSink', () => {
  it('creates exactly one root for concurrent intents on the same seed', async () => {
    const { api, calls, resolveIds } = fakeTracing()
    const sink = new LangfuseSink(api)
    sink.emit([rootIntent])
    sink.emit([
      { kind: 'tool', seed: 'argus-session-7', name: 'read_file', isError: false },
      { kind: 'tool', seed: 'argus-session-7', name: 'grep', isError: false }
    ])
    resolveIds()
    await sink.flush()
    const roots = calls.start.filter((c) => (c as { name: string }).name === 'auth-bug · session 7')
    expect(roots).toHaveLength(1)
  })

  it('sets traceName on the root so the trace is not left unnamed', async () => {
    const { api, calls, resolveIds } = fakeTracing()
    const sink = new LangfuseSink(api)
    sink.emit([rootIntent])
    resolveIds()
    await sink.flush()
    const root = calls.start.find(
      (c) => (c as { name: string }).name === 'auth-bug · session 7'
    ) as { opts: { traceName?: string } }
    expect(root.opts.traceName).toBe('auth-bug · session 7')
  })

  it('resolves an intent that arrives before its trace-root into the same trace', async () => {
    const { api, calls, resolveIds } = fakeTracing()
    const sink = new LangfuseSink(api)
    sink.emit([{ kind: 'tool', seed: 'argus-session-7', name: 'early', isError: false }])
    sink.emit([rootIntent])
    resolveIds()
    await sink.flush()
    const traceIds = calls.start.map(
      (c) =>
        (c as { opts: { parentSpanContext: { traceId: string } } }).opts.parentSpanContext.traceId
    )
    expect(new Set(traceIds)).toEqual(new Set(['trace-argus-session-7']))
    // The fallback root (named after the seed) plus the real one must not both exist.
    expect(
      calls.start.filter((c) => (c as { name: string }).name === 'auth-bug · session 7')
    ).toHaveLength(0)
  })

  it('does not set traceName when no trace-root intent is present', async () => {
    // A scoreFinding() for a session that ended in an earlier app run reaches the
    // sink with no trace-root. That trace already carries its real name in Langfuse;
    // writing the raw seed here would overwrite it.
    const { api, calls, resolveIds } = fakeTracing()
    const sink = new LangfuseSink(api)
    sink.emit([{ kind: 'score', seed: 'argus-session-7', name: 'finding_accepted', value: 1 }])
    resolveIds()
    await sink.flush()
    const fallbackRoot = calls.start[0] as { opts: { traceName?: string } }
    expect(fallbackRoot.opts.traceName).toBeUndefined()
  })

  it('settles in-flight work before forcing a flush', async () => {
    const { api, calls, resolveIds } = fakeTracing()
    const sink = new LangfuseSink(api)
    sink.emit([rootIntent])
    const flushed = sink.flush()
    expect(calls.flush).toHaveLength(0) // still waiting on trace id resolution
    resolveIds()
    await flushed
    expect(calls.start.length).toBeGreaterThan(0)
    expect(calls.flush).toHaveLength(1)
  })

  it('routes score intents through createScore with the resolved trace id', async () => {
    const { api, calls, resolveIds } = fakeTracing()
    const sink = new LangfuseSink(api)
    sink.emit([
      rootIntent,
      { kind: 'score', seed: 'argus-session-7', name: 'turn_error', value: 1 }
    ])
    resolveIds()
    await sink.flush()
    expect(calls.score).toEqual([
      { traceId: 'trace-argus-session-7', name: 'turn_error', value: 1, comment: undefined }
    ])
  })

  it('is idempotent on shutdown', async () => {
    const { api, calls, resolveIds } = fakeTracing()
    const sink = new LangfuseSink(api)
    sink.emit([rootIntent])
    resolveIds()
    await sink.shutdown()
    await sink.shutdown()
    expect(calls.shutdown).toHaveLength(1)
  })

  it('does not let one failing intent reject flush', async () => {
    const { api, resolveIds } = fakeTracing()
    const boom: TracingApi = {
      ...api,
      startObservation: () => {
        throw new Error('span failed')
      }
    }
    const sink = new LangfuseSink(boom)
    sink.emit([rootIntent])
    resolveIds()
    await expect(sink.flush()).resolves.toBeUndefined()
    expect(sink.lastError()).toContain('span failed')
  })
})
