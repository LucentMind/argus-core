import { describe, it, expect } from 'vitest'
import { initialState, reduce, type ExporterState } from '../reducer'
import type { ObservationIntent } from '../intent'
import type { AgentEvent } from '../../../../shared/agent-events'

const T0 = '2026-07-19T10:00:00.000Z'
const T1 = '2026-07-19T10:00:05.000Z'
const T2 = '2026-07-19T10:00:07.000Z'

const base = { eventId: 'e', caseId: 1, caseSlug: 'auth-bug', sessionId: 7, turnId: 3, ts: T0 }

/** Drives a sequence through the reducer, returning every intent produced. */
function run(
  events: AgentEvent[],
  opts = { captureContent: false },
  state: ExporterState = initialState()
): ObservationIntent[] {
  const out: ObservationIntent[] = []
  let s = state
  for (const e of events) {
    const [next, intents] = reduce(s, e, opts)
    s = next
    out.push(...intents)
  }
  return out
}

const started = (over: Partial<typeof base> = {}, resumed = false): AgentEvent =>
  ({
    ...base,
    ...over,
    type: 'session.started',
    payload: { model: 'claude-opus-4-8', resumed }
  }) as AgentEvent

const turnStarted = (userText: string, ts = T0): AgentEvent =>
  ({ ...base, ts, type: 'turn.started', payload: { userText } }) as AgentEvent

const turnCompleted = (
  status: 'success' | 'error' | 'interrupted' = 'success',
  ts = T1
): AgentEvent =>
  ({
    ...base,
    ts,
    type: 'turn.completed',
    payload: { status, inputTokens: 10, outputTokens: 5, costUsd: 0.01, durationMs: 5000 }
  }) as AgentEvent

describe('reduce', () => {
  it('emits a trace-root for a fresh session', () => {
    const intents = run([started()])
    expect(intents).toEqual([
      {
        kind: 'trace-root',
        seed: 'argus-session-7',
        name: 'auth-bug · session 7',
        metadata: { caseSlug: 'auth-bug', caseId: 1 }
      }
    ])
  })

  it('emits a generation with usage, cost and real duration on turn.completed', () => {
    const intents = run([started(), turnStarted('hi'), turnCompleted()])
    expect(intents).toContainEqual({
      kind: 'generation',
      seed: 'argus-session-7',
      name: 'turn',
      model: 'claude-opus-4-8',
      startTime: Date.parse(T0),
      endTime: Date.parse(T1),
      usage: { input: 10, output: 5 },
      costUsd: 0.01
    })
  })

  it('omits content when captureContent is false', () => {
    const intents = run([started(), turnStarted('secret log line'), turnCompleted()])
    expect(JSON.stringify(intents)).not.toContain('secret log line')
  })

  it('includes content when captureContent is true', () => {
    const intents = run(
      [
        started(),
        turnStarted('secret log line'),
        { ...base, type: 'assistant.message', payload: { text: 'reply text' } } as AgentEvent,
        turnCompleted()
      ],
      { captureContent: true }
    )
    const gen = intents.find((i) => i.kind === 'generation')
    expect(gen).toMatchObject({ input: 'secret log line', output: 'reply text' })
  })

  it('emits a turn_error score on an errored turn', () => {
    const intents = run([started(), turnStarted('x'), turnCompleted('error')])
    expect(intents).toContainEqual({
      kind: 'score',
      seed: 'argus-session-7',
      name: 'turn_error',
      value: 1
    })
  })

  it('pairs tool.call.started with completed to produce a tool intent with duration', () => {
    const intents = run([
      started(),
      {
        ...base,
        ts: T0,
        type: 'tool.call.started',
        payload: { toolCallId: 'tc1', name: 'read_file' }
      } as AgentEvent,
      {
        ...base,
        ts: T2,
        type: 'tool.call.completed',
        payload: { toolCallId: 'tc1', name: 'read_file', outputPreview: 'contents', isError: false }
      } as AgentEvent
    ])
    expect(intents).toContainEqual({
      kind: 'tool',
      seed: 'argus-session-7',
      name: 'read_file',
      startTime: Date.parse(T0),
      endTime: Date.parse(T2),
      isError: false
    })
  })

  it('scores hitl_approved 1 for allow and 0 for deny', () => {
    const mk = (decision: 'allow' | 'deny'): AgentEvent =>
      ({ ...base, type: 'request.resolved', payload: { requestId: 'r', decision } }) as AgentEvent
    expect(run([started(), mk('allow')])).toContainEqual({
      kind: 'score',
      seed: 'argus-session-7',
      name: 'hitl_approved',
      value: 1
    })
    expect(run([started(), mk('deny')])).toContainEqual({
      kind: 'score',
      seed: 'argus-session-7',
      name: 'hitl_approved',
      value: 0
    })
  })

  it('drops session state on session.exited so a later turn.completed is a no-op', () => {
    const intents = run([
      started(),
      { ...base, type: 'session.exited', payload: { reason: 'stopped' } } as AgentEvent,
      turnCompleted()
    ])
    expect(intents.filter((i) => i.kind === 'generation')).toHaveLength(0)
  })

  it('ignores events for an unknown session', () => {
    expect(run([turnCompleted()])).toEqual([])
  })

  it('omits timing when the event timestamp is unparseable', () => {
    const intents = run([
      started(),
      turnStarted('x', 'not-a-date'),
      turnCompleted('success', 'nope')
    ])
    const gen = intents.find((i) => i.kind === 'generation')
    expect(gen).not.toHaveProperty('startTime')
    expect(gen).not.toHaveProperty('endTime')
  })

  it('emits a resume marker rather than a second trace-root', () => {
    const s = initialState()
    run([started()], { captureContent: false }, s)
    // Passing the same `s` into both run() calls is deliberate, not a copy-paste
    // slip: reduce() mutates state in place (see its docblock), so this threads
    // the session state from the first run into the second the way index.ts's
    // real long-lived state does across events.
    const second = run([started({}, true)], { captureContent: false }, s)
    expect(second).toEqual([{ kind: 'event', seed: 'argus-session-7', name: 'session resumed' }])
  })

  it('creates session state on a resume with no prior state (restarted app)', () => {
    const s = initialState()
    const intents = run(
      [started({}, true), turnStarted('x'), turnCompleted()],
      { captureContent: false },
      s
    )
    expect(intents).toContainEqual(
      expect.objectContaining({ kind: 'event', name: 'session resumed' })
    )
    expect(intents).toContainEqual(expect.objectContaining({ kind: 'generation', name: 'turn' }))
  })

  it('emits an ERROR-level event for session.error', () => {
    const intents = run([
      started(),
      { ...base, type: 'session.error', payload: { message: 'backend died' } } as AgentEvent
    ])
    expect(intents).toContainEqual({
      kind: 'event',
      seed: 'argus-session-7',
      name: 'session error',
      level: 'ERROR',
      metadata: { message: 'backend died' }
    })
  })

  it('ignores session.error for an unknown session', () => {
    const intents = run([
      { ...base, type: 'session.error', payload: { message: 'orphan' } } as AgentEvent
    ])
    expect(intents).toEqual([])
  })

  it('omits tool duration when the start event was never seen', () => {
    const intents = run([
      started(),
      {
        ...base,
        ts: T2,
        type: 'tool.call.completed',
        payload: { toolCallId: 'unknown', name: 'grep', outputPreview: 'x', isError: true }
      } as AgentEvent
    ])
    const tool = intents.find((i) => i.kind === 'tool')
    expect(tool).toMatchObject({ name: 'grep', isError: true, endTime: Date.parse(T2) })
    expect(tool).not.toHaveProperty('startTime')
  })
})
