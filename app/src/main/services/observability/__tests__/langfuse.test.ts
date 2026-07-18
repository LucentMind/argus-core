import { describe, it, expect, vi } from 'vitest'
import { LangfuseExporter } from '../langfuse'
import type { ObservationSink } from '../sink'
import type { ObservationIntent } from '../intent'
import type { AgentEvent } from '../../../../shared/agent-events'
import type { FindingRow } from '../../../../shared/observability'

function fakeSink(): { sink: ObservationSink; seen: ObservationIntent[] } {
  const seen: ObservationIntent[] = []
  return {
    seen,
    sink: {
      emit: (intents) => seen.push(...intents),
      flush: vi.fn().mockResolvedValue(undefined),
      shutdown: vi.fn().mockResolvedValue(undefined)
    }
  }
}

const base = {
  eventId: 'e',
  caseId: 1,
  caseSlug: 'auth-bug',
  sessionId: 7,
  turnId: 3,
  ts: '2026-07-19T10:00:00.000Z'
}

const started = (): AgentEvent =>
  ({ ...base, type: 'session.started', payload: { model: 'm', resumed: false } }) as AgentEvent

describe('LangfuseExporter', () => {
  it('forwards reducer intents to the sink', () => {
    const { sink, seen } = fakeSink()
    new LangfuseExporter(sink, { captureContent: false }).handle(started())
    expect(seen).toEqual([expect.objectContaining({ kind: 'trace-root', seed: 'argus-session-7' })])
  })

  it('emits a finding_accepted score for a reviewed finding', () => {
    const { sink, seen } = fakeSink()
    const ex = new LangfuseExporter(sink, { captureContent: false })
    ex.scoreFinding({ sessionId: 7, reviewState: 'accepted' } as FindingRow)
    expect(seen).toEqual([
      { kind: 'score', seed: 'argus-session-7', name: 'finding_accepted', value: 1 }
    ])
  })

  it('ignores pending findings and findings with no session', () => {
    const { sink, seen } = fakeSink()
    const ex = new LangfuseExporter(sink, { captureContent: false })
    ex.scoreFinding({ sessionId: 7, reviewState: 'pending' } as FindingRow)
    ex.scoreFinding({ sessionId: null, reviewState: 'accepted' } as FindingRow)
    ex.scoreFinding(null)
    expect(seen).toEqual([])
  })

  it('surfaces a sink failure through lastError without throwing', () => {
    const sink: ObservationSink = {
      emit: () => {
        throw new Error('down')
      },
      flush: async () => {},
      shutdown: async () => {}
    }
    const ex = new LangfuseExporter(sink, { captureContent: false })
    expect(() => ex.handle(started())).not.toThrow()
    expect(ex.lastError()).toContain('down')
  })

  it('does not report a reducer bug as a connector fault', () => {
    const { sink } = fakeSink()
    const ex = new LangfuseExporter(sink, { captureContent: false })
    const spy = vi.spyOn(console, 'error').mockImplementation(() => {})
    // sessionId is required by the reducer; a malformed event must not poison lastError.
    expect(() => ex.handle({ ...base, type: 'session.started' } as AgentEvent)).not.toThrow()
    expect(ex.lastError()).toBeNull()
    spy.mockRestore()
  })
})
