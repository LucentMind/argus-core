import { describe, expect, it } from 'vitest'
import { renderAutonomyReport } from '../report'
import type { AutonomyPayload, LaneMetrics } from '../../../../shared/autonomy'

const m = (lane: LaneMetrics['lane'], over: Partial<LaneMetrics> = {}): LaneMetrics => ({
  lane,
  windowDays: 30,
  decisions: 0,
  accepted: 0,
  acceptanceRate: null,
  costUsd: null,
  rejectReasons: {},
  depth: {},
  dataStart: null,
  ...over
})

const payload: AutonomyPayload = {
  contractVersion: 1,
  argusVersion: '1.2.3',
  instanceId: 'abc-123',
  windowDays: 30,
  lanes: [
    {
      lane: 'triage',
      label: 'Triage suggestions',
      tier: 2,
      baseline: 1,
      bar: { minDecisions: 10, minAcceptanceRate: 0.8 },
      clearsBar: true,
      metrics: m('triage', {
        decisions: 12,
        accepted: 10,
        acceptanceRate: 10 / 12,
        costUsd: 3.5,
        dataStart: '2026-08-01T00:00:00.000Z'
      }),
      allTime: m('triage', { windowDays: null, decisions: 20, accepted: 15, acceptanceRate: 0.75 }),
      events: [
        {
          id: 1,
          lane: 'triage',
          kind: 'promote',
          fromTier: 1,
          toTier: 2,
          note: 'Q3 bar cleared',
          metricsSnapshot: m('triage', { decisions: 12, accepted: 10, acceptanceRate: 10 / 12 }),
          createdAt: '2026-08-10T00:00:00.000Z',
          acknowledgedAt: null
        }
      ]
    },
    {
      lane: 'distill',
      label: 'Distill proposals',
      tier: 1,
      baseline: 1,
      bar: { minDecisions: 10, minAcceptanceRate: 0.8 },
      clearsBar: false,
      metrics: m('distill', {
        decisions: 4,
        accepted: 2,
        acceptanceRate: 0.5,
        rejectReasons: { overfit: 2 }
      }),
      allTime: m('distill', { windowDays: null }),
      events: []
    },
    {
      lane: 'review-finding',
      label: 'Review findings',
      tier: 3,
      baseline: 3,
      bar: { minDecisions: 10, minAcceptanceRate: 0.8 },
      clearsBar: false,
      metrics: m('review-finding', { depth: { posted: 5, applied: 2 } }),
      allTime: m('review-finding', { windowDays: null }),
      events: []
    },
    {
      lane: 'rca',
      label: 'RCA reports',
      tier: 1,
      baseline: 1,
      bar: { minDecisions: 10, minAcceptanceRate: 0.8 },
      clearsBar: false,
      metrics: m('rca', { depth: { generated: 3, confirmed: 2, postedOk: 1 } }),
      allTime: m('rca', { windowDays: null }),
      events: []
    }
  ],
  unackedDemotions: 0,
  timeInTriage: { medianMs: 2 * 24 * 3600 * 1000, p90Ms: 5 * 24 * 3600 * 1000, cases: 7 },
  costPerResolvedCaseUsd: 4.21,
  resolvedCases: 12
}

describe('renderAutonomyReport', () => {
  it('renders every section with honest gaps', () => {
    const md = renderAutonomyReport(payload, new Date('2026-08-12T12:00:00Z'))
    expect(md).toContain('# Autonomy review — 2026-08-12')
    expect(md).toContain('| Triage suggestions | A2 | 12 | 83% (10/12) | $3.50 | 2026-08-01 |')
    expect(md).toContain('| Distill proposals | A1 | 4 | 50% (2/4) | unattributed |')
    expect(md).toContain('- overfit: 2')
    expect(md).toContain('posted 5, applied 2')
    expect(md).toContain('generated 3, confirmed 2, posted-ok 1')
    expect(md).toContain('median 2.0 d')
    expect(md).toContain('$4.21 over 12 resolved cases')
    expect(md).toContain('promote A1→A2 — Q3 bar cleared')
    expect(md).toContain('stamped decisions only')
  })
})
