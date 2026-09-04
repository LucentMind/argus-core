// @vitest-environment jsdom
import { render, screen } from '@testing-library/react'
import { describe, it, expect, vi, beforeEach } from 'vitest'
import '@testing-library/jest-dom/vitest'
import { DistillationSection } from '../DistillationSection'
import { defaultSettings, type SettingsPayload } from '../../../../../shared/settings'
import type { DistillationUsageStats, UsageStatsPayload } from '../../../../../shared/observability'

/**
 * The spend row moved here from the Memory page (user-directed, 2026-08-21) — these four cases
 * came with it. What they cover is the row's arithmetic and its omissions: a null average must
 * not render as `$0.00`, and a zero failed-spend must render nothing at all rather than a chip
 * saying zero.
 */
function stats(distillation: DistillationUsageStats): UsageStatsPayload {
  return {
    hygiene: { staleDays: 45, minRecalls: 3, trackingStartedAt: '2026-01-01T00:00:00.000Z' },
    skills: [],
    memory: [],
    references: [],
    archived: [],
    distillation
  } as unknown as UsageStatsPayload
}

const NO_RUNS: DistillationUsageStats = {
  jobCount: 0,
  totalCostUsd: null,
  failedCostUsd: null,
  failedCount: 0,
  avgCostUsd: null,
  avgTurnCount: null,
  avgPromptChars: null,
  dryRunCount: 0,
  dryRunCostUsd: null
}

function payload(): SettingsPayload {
  return {
    settings: defaultSettings(),
    resolvedTools: [],
    dataRoot: { path: 'C:\\Users\\x\\Argus', fromEnv: false },
    loadError: null
  }
}

let statsMock: ReturnType<typeof vi.fn>

beforeEach(() => {
  statsMock = vi.fn(async () => stats(NO_RUNS))
  window.argus = {
    settings: { patch: vi.fn(async () => payload()) },
    usage: { stats: statsMock }
  } as never
})

describe('DistillationSection spend row', () => {
  it('shows no run row when no case job has ever completed', async () => {
    render(<DistillationSection payload={payload()} />)
    await screen.findByText('Distillation provider')
    expect(screen.queryByText(/completed run/)).not.toBeInTheDocument()
  })

  it('surfaces totals and averages once runs exist', async () => {
    statsMock.mockResolvedValue(
      stats({
        jobCount: 2,
        totalCostUsd: 2,
        avgCostUsd: 1,
        avgPromptChars: 3000,
        avgTurnCount: 15,
        failedCostUsd: null,
        failedCount: 0,
        dryRunCount: 0,
        dryRunCostUsd: null
      })
    )
    render(<DistillationSection payload={payload()} />)
    expect(await screen.findByText('2 completed runs')).toBeInTheDocument()
    expect(screen.getByText('$2.00 total')).toBeInTheDocument()
    expect(screen.getByText(/avg \$1\.00/)).toBeInTheDocument()
    expect(screen.getByText(/avg 15\.0 turns/)).toBeInTheDocument()
    expect(screen.getByText(/avg 3000 prompt chars/)).toBeInTheDocument()
    // No failed spend recorded — the chip must not appear at all, not render "$0.00".
    expect(screen.queryByText(/on failed runs/)).not.toBeInTheDocument()
  })

  it('shows a jobCount-only row when no run has ever recorded usage (pre-v2 rows)', async () => {
    statsMock.mockResolvedValue(
      stats({
        jobCount: 1,
        totalCostUsd: null,
        avgCostUsd: null,
        avgPromptChars: null,
        avgTurnCount: null,
        failedCostUsd: null,
        failedCount: 0,
        dryRunCount: 0,
        dryRunCostUsd: null
      })
    )
    render(<DistillationSection payload={payload()} />)
    expect(await screen.findByText('1 completed run')).toBeInTheDocument()
    expect(screen.getByText(/no usage recorded/)).toBeInTheDocument()
    expect(screen.queryByText(/total$/)).not.toBeInTheDocument()
  })

  it('shows a failed-runs chip when failed capHit spend was recorded', async () => {
    statsMock.mockResolvedValue(
      stats({
        jobCount: 2,
        totalCostUsd: 2,
        avgCostUsd: 1,
        avgPromptChars: 3000,
        avgTurnCount: 15,
        failedCostUsd: 4.5,
        failedCount: 1,
        dryRunCount: 0,
        dryRunCostUsd: null
      })
    )
    render(<DistillationSection payload={payload()} />)
    expect(await screen.findByText('2 completed runs')).toBeInTheDocument()
    expect(screen.getByText('+$4.50 on failed runs')).toBeInTheDocument()
  })

  it('renders the settings rows even when the usage call fails', async () => {
    statsMock.mockRejectedValue(new Error('db locked'))
    render(<DistillationSection payload={payload()} />)
    // A stats outage must not surface as an error on a settings page — the row is simply absent.
    expect(await screen.findByText('Distillation provider')).toBeInTheDocument()
    expect(screen.queryByText(/completed run/)).not.toBeInTheDocument()
  })
})
