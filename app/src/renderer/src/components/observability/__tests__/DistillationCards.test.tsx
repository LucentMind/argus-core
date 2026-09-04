// @vitest-environment jsdom
import '@testing-library/jest-dom/vitest'
import { render, screen, fireEvent, waitFor } from '@testing-library/react'
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { DistillationCards } from '../DistillationCards'

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
    expect(screen.getByText('5')).toBeInTheDocument()
    expect(screen.getByText('1 failed')).toBeInTheDocument()
    expect(screen.getByText('$12.50')).toBeInTheDocument()
    expect(screen.getByText('avg $2.50 / run')).toBeInTheDocument()
    expect(screen.getByText('$3.00')).toBeInTheDocument()
    expect(screen.getByText('$4.20')).toBeInTheDocument()
    expect(screen.getByText('2 dry runs')).toBeInTheDocument()
  })
  it('hides itself entirely when nothing has run', async () => {
    ;(window.argus.usage.stats as ReturnType<typeof vi.fn>).mockResolvedValue(
      stats({ jobCount: 0, dryRunCount: 0 })
    )
    const { container } = render(<DistillationCards hiddenCards={[]} />)
    await waitFor(() => expect(window.argus.usage.stats).toHaveBeenCalled())
    expect(container).toBeEmptyDOMElement()
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
})
