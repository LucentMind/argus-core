// @vitest-environment jsdom
import '@testing-library/jest-dom/vitest'
import { render, screen, fireEvent, waitFor } from '@testing-library/react'
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { DistillationCards } from '../DistillationCards'
import { DASHBOARD_CARDS } from '../../settings/ObservabilitySettings'

const stats = (d: Record<string, unknown>): Record<string, unknown> => ({
  hygiene: {},
  skills: [],
  memory: [],
  references: [],
  archived: [],
  distillation: {
    jobCount: 5,
    failedCount: 1,
    totalCostUsd: 12.5,
    avgCostUsd: 2.5,
    avgPromptChars: 1000,
    avgTurnCount: 6,
    failedCostUsd: 3,
    dryRunCount: 2,
    dryRunCostUsd: 4.2,
    ...d
  }
})
beforeEach(() => {
  window.argus = { usage: { stats: vi.fn(async () => stats({})) } } as never
})

describe('DistillationCards', () => {
  it('renders the four cards from usage.stats(since)', async () => {
    render(<DistillationCards since="2026-08-01T00:00:00.000Z" hiddenCards={[]} />)
    expect(await screen.findByText('Distillation runs')).toBeInTheDocument()
    expect(window.argus.usage.stats).toHaveBeenCalledWith({ since: '2026-08-01T00:00:00.000Z' })
    // jobCount (5, done only) + failedCount (1) = 6: the value is every run counted, so the sub
    // ("1 failed") reads as a true subset of it rather than a second, disjoint count.
    expect(screen.getByText('6')).toBeInTheDocument()
    expect(screen.getByText('1 failed')).toBeInTheDocument()
    expect(screen.getByText('$12.50')).toBeInTheDocument()
    expect(screen.getByText('avg $2.50 / run')).toBeInTheDocument()
    expect(screen.getByText('$3.00')).toBeInTheDocument()
    expect(screen.getByText('$4.20')).toBeInTheDocument()
    expect(screen.getByText('2 dry runs')).toBeInTheDocument()
  })
  it('hides itself entirely when nothing has run', async () => {
    ;(window.argus.usage.stats as ReturnType<typeof vi.fn>).mockResolvedValue(
      stats({ jobCount: 0, dryRunCount: 0, failedCount: 0 })
    )
    const { container } = render(<DistillationCards hiddenCards={[]} />)
    await waitFor(() => expect(window.argus.usage.stats).toHaveBeenCalled())
    expect(container).toBeEmptyDOMElement()
  })
  it('a corpus of only failed runs still shows its spend, not the empty state', async () => {
    ;(window.argus.usage.stats as ReturnType<typeof vi.fn>).mockResolvedValue(
      stats({ jobCount: 0, failedCount: 2, dryRunCount: 0, failedCostUsd: 3 })
    )
    render(<DistillationCards hiddenCards={[]} />)
    expect(await screen.findByText('Distillation runs')).toBeInTheDocument()
    expect(screen.getByText('2')).toBeInTheDocument()
    expect(screen.getByText('2 failed')).toBeInTheDocument()
    expect(screen.getByText('Failed-run spend')).toBeInTheDocument()
    expect(screen.getByText('$3.00')).toBeInTheDocument()
  })
  it('honours hiddenCards and shows the dev-only Open runs link only with a handler', async () => {
    const onOpenRuns = vi.fn()
    const { rerender } = render(
      <DistillationCards hiddenCards={['distill.drySpend']} onOpenRuns={onOpenRuns} />
    )
    await screen.findByText('Distillation runs')
    expect(screen.queryByText('Dry-run spend')).toBeNull()
    fireEvent.click(screen.getByRole('button', { name: 'Open runs' }))
    expect(onOpenRuns).toHaveBeenCalled()
    rerender(<DistillationCards hiddenCards={[]} />)
    expect(screen.queryByRole('button', { name: 'Open runs' })).toBeNull()
  })
  it('hiding every DASHBOARD_CARDS id renders no [data-card-id] element, even with non-zero stats', async () => {
    const { container } = render(
      <DistillationCards hiddenCards={DASHBOARD_CARDS.map((c) => c.id)} />
    )
    await screen.findByText('Distillation')
    expect(container.querySelector('[data-card-id]')).toBeNull()
  })
})
