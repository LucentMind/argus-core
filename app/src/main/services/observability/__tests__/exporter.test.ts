import { createHash } from 'node:crypto'
import { describe, it, expect, vi } from 'vitest'
import { ObservationExporter } from '../exporter'
import { seedFor } from '../intent'
import type { ObservationSink } from '../sink'
import type { ObservationIntent } from '../intent'
import type { AgentEvent } from '../../../../shared/agent-events'
import type { AssetAttributionEvent } from '../../../../shared/attribution'
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

describe('ObservationExporter', () => {
  it('forwards reducer intents to the sink', () => {
    const { sink, seen } = fakeSink()
    new ObservationExporter(sink, { captureContent: false }).handle(started())
    expect(seen).toEqual([expect.objectContaining({ kind: 'trace-root', seed: 'argus-session-7' })])
  })

  it('scoreAttributions pushes one asset.contribution score per non-silent event with metadata', () => {
    const { sink, seen } = fakeSink()
    const x = new ObservationExporter(sink, { captureContent: false })
    const ev = (
      label: 'helped' | 'misled' | 'silent',
      value: 1 | -1 | null
    ): AssetAttributionEvent => ({
      'gen_ai.evaluation.name': 'asset.contribution' as const,
      'gen_ai.evaluation.score.value': value,
      'gen_ai.evaluation.score.label': label,
      'gen_ai.evaluation.explanation': 'why',
      'argus.asset.kind': 'skill' as const,
      'argus.asset.name': 'diag',
      'argus.asset.tier': 'user',
      'argus.case.domain': 'NAV',
      'argus.case.outcome': 'solved' as const,
      'argus.case.slug': 'c1',
      'argus.install.id': 'i',
      'argus.app.version': 'v',
      'argus.judge.model': 'm',
      'argus.judge.prompt_hash': 'h'
    })
    x.scoreAttributions(42, [ev('helped', 1), ev('silent', null), ev('misled', -1)])
    expect(seen).toEqual([
      expect.objectContaining({
        kind: 'score',
        seed: seedFor(42),
        name: 'asset.contribution',
        value: 1,
        comment: 'why',
        metadata: expect.objectContaining({
          'argus.asset.name': 'diag',
          'argus.case.domain': 'NAV'
        })
      }),
      expect.objectContaining({ kind: 'score', value: -1 })
    ])
    const md = (seen[0] as { metadata: Record<string, unknown> }).metadata
    expect(md['gen_ai.evaluation.score.value']).toBeUndefined()
    expect(md['gen_ai.evaluation.score.label']).toBeUndefined()
    expect(md['gen_ai.evaluation.name']).toBeUndefined()
    expect(md['gen_ai.evaluation.explanation']).toBe('why')
  })

  it('gives each (install, case, kind, name) a deterministic score id so re-emission upserts (A6)', () => {
    const { sink, seen } = fakeSink()
    const x = new ObservationExporter(sink, { captureContent: false })
    const ev = (name: string, value: 1 | -1): AssetAttributionEvent => ({
      'gen_ai.evaluation.name': 'asset.contribution' as const,
      'gen_ai.evaluation.score.value': value,
      'gen_ai.evaluation.score.label': value === 1 ? 'helped' : 'misled',
      'gen_ai.evaluation.explanation': 'why',
      'argus.asset.kind': 'skill' as const,
      'argus.asset.name': name,
      'argus.asset.tier': 'user',
      'argus.case.domain': 'NAV',
      'argus.case.outcome': 'solved' as const,
      'argus.case.slug': 'c1',
      'argus.install.id': 'i',
      'argus.app.version': 'v',
      'argus.judge.model': 'm',
      'argus.judge.prompt_hash': 'h'
    })
    x.scoreAttributions(42, [ev('diag', 1), ev('diag', -1), ev('other', 1)])
    const ids = seen.map((s) => (s as { id?: string }).id)
    const expected = createHash('sha256').update('i|c1|skill|diag').digest('hex').slice(0, 32)
    expect(ids[0]).toBe(expected)
    expect(ids[0]).toMatch(/^[0-9a-f]{32}$/)
    expect(ids[1]).toBe(ids[0]) // the override re-emit of the same asset replaces, not adds
    expect(ids[2]).not.toBe(ids[0])
  })

  it('emits a finding_accepted score for a reviewed finding', () => {
    const { sink, seen } = fakeSink()
    const ex = new ObservationExporter(sink, { captureContent: false })
    ex.scoreFinding({ sessionId: 7, reviewState: 'accepted' } as FindingRow)
    expect(seen).toEqual([
      { kind: 'score', seed: 'argus-session-7', name: 'finding_accepted', value: 1 }
    ])
  })

  it('ignores pending findings and findings with no session', () => {
    const { sink, seen } = fakeSink()
    const ex = new ObservationExporter(sink, { captureContent: false })
    ex.scoreFinding({ sessionId: 7, reviewState: 'pending' } as FindingRow)
    ex.scoreFinding({ sessionId: null, reviewState: 'accepted' } as FindingRow)
    ex.scoreFinding(null)
    expect(seen).toEqual([])
  })

  it('records a synchronous emit throw', () => {
    const sink: ObservationSink = {
      emit: () => {
        throw new Error('down')
      },
      flush: async () => {},
      shutdown: async () => {}
    }
    const ex = new ObservationExporter(sink, { captureContent: false })
    expect(() => ex.handle(started())).not.toThrow()
    expect(ex.lastError()).toContain('down')
  })

  it('does not report a reducer bug as a connector fault', () => {
    const { sink } = fakeSink()
    const ex = new ObservationExporter(sink, { captureContent: false })
    const spy = vi.spyOn(console, 'error').mockImplementation(() => {})
    // sessionId is required by the reducer; a malformed event must not poison lastError.
    expect(() => ex.handle({ ...base, type: 'session.started' } as AgentEvent)).not.toThrow()
    expect(ex.lastError()).toBeNull()
    spy.mockRestore()
  })
})
