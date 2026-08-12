// @vitest-environment jsdom
import { fireEvent, render, screen, waitFor } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import '@testing-library/jest-dom/vitest'
import AutonomyStandalone from '../AutonomyStandalone'
import { autonomyStore } from '../../../lib/autonomyStore'
import type { AutonomyPayload, LaneStatus } from '../../../../../shared/autonomy'

const lane = (over: Partial<LaneStatus>): LaneStatus => ({
  lane: 'triage',
  label: 'Triage suggestions',
  tier: 1,
  baseline: 1,
  bar: { minDecisions: 10, minAcceptanceRate: 0.8 },
  clearsBar: false,
  metrics: {
    lane: 'triage',
    windowDays: 30,
    decisions: 3,
    accepted: 2,
    acceptanceRate: 2 / 3,
    costUsd: 1.5,
    rejectReasons: {},
    depth: {},
    dataStart: null
  },
  allTime: {
    lane: 'triage',
    windowDays: null,
    decisions: 3,
    accepted: 2,
    acceptanceRate: 2 / 3,
    costUsd: 1.5,
    rejectReasons: {},
    depth: {},
    dataStart: null
  },
  events: [],
  ...over
})

const payload: AutonomyPayload = {
  contractVersion: 1,
  argusVersion: 't',
  instanceId: 'i',
  windowDays: 30,
  lanes: [
    lane({}),
    lane({
      lane: 'distill',
      label: 'Distill proposals',
      metrics: {
        ...lane({}).metrics,
        lane: 'distill',
        decisions: 12,
        accepted: 11,
        acceptanceRate: 11 / 12,
        costUsd: null
      },
      clearsBar: true
    })
  ],
  unackedDemotions: 1,
  timeInTriage: { medianMs: 172800000, p90Ms: 432000000, cases: 7 },
  costPerResolvedCaseUsd: 4.21,
  resolvedCases: 12
}

beforeEach(() => {
  autonomyStore.reset()
  ;(window as unknown as { argus: unknown }).argus = {
    autonomy: {
      status: vi.fn().mockResolvedValue(payload),
      onChanged: vi.fn(() => () => undefined),
      promote: vi.fn().mockResolvedValue(payload),
      demote: vi.fn().mockResolvedValue(payload),
      ack: vi.fn().mockResolvedValue(payload),
      reportGenerate: vi
        .fn()
        .mockResolvedValue({ file: 'C:/x/autonomy-review-2026-08-12.md', markdown: '# report' }),
      reportPost: vi
        .fn()
        .mockResolvedValue({ confluencePage: { ok: true, url: 'https://c/1', at: 'x' } })
    }
  }
})

describe('AutonomyStandalone', () => {
  it('renders lanes with tier badges and gates promote on the bar', async () => {
    render(<AutonomyStandalone onClose={() => {}} />)
    expect(await screen.findByText('Triage suggestions')).toBeInTheDocument()
    const promotes = screen.getAllByRole('button', { name: /promote/i })
    expect(promotes[0]).toBeDisabled() // triage: below bar
    expect(promotes[1]).toBeEnabled() // distill: clears bar
  })

  it('generates then posts the report', async () => {
    render(<AutonomyStandalone onClose={() => {}} />)
    fireEvent.click(await screen.findByRole('button', { name: /generate report/i }))
    expect(await screen.findByText('# report')).toBeInTheDocument()
    fireEvent.click(screen.getByRole('button', { name: /post to confluence/i }))
    await waitFor(() =>
      expect(window.argus.autonomy.reportPost).toHaveBeenCalledWith(
        'C:/x/autonomy-review-2026-08-12.md'
      )
    )
    expect(await screen.findByText(/https:\/\/c\/1/)).toBeInTheDocument()
  })

  it('shows the global tiles', async () => {
    render(<AutonomyStandalone onClose={() => {}} />)
    expect(await screen.findByText(/2\.0 d/)).toBeInTheDocument() // triage median
    expect(screen.getByText(/\$4\.21/)).toBeInTheDocument()
  })
})
