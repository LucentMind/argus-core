// @vitest-environment jsdom
import { render, screen, fireEvent } from '@testing-library/react'
import { describe, it, expect } from 'vitest'
import '@testing-library/jest-dom/vitest'
import { RunSummaryText, TriggerChip } from '../runDisplay'
import type { RoutineRunSummary } from '../../../../../shared/routines'

function run(over: Partial<RoutineRunSummary> = {}): RoutineRunSummary {
  return {
    id: 1,
    routineId: 'sweep',
    caseSlug: 'routine-sweep',
    sessionId: 7,
    trigger: 'manual',
    status: 'ok',
    startedAt: '2026-08-03T02:00:00.000Z',
    finishedAt: '2026-08-03T02:05:00.000Z',
    summary: 'nothing new',
    error: null,
    reviewedAt: null,
    ...over
  }
}

describe('TriggerChip', () => {
  it('names all three triggers', () => {
    const { rerender } = render(<TriggerChip run={run({ trigger: 'manual' })} />)
    expect(screen.getByTestId('run-trigger-1')).toHaveTextContent('manual')
    rerender(<TriggerChip run={run({ trigger: 'scheduled' })} />)
    expect(screen.getByTestId('run-trigger-1')).toHaveTextContent('scheduled')
    rerender(<TriggerChip run={run({ trigger: 'catchup' })} />)
    expect(screen.getByTestId('run-trigger-1')).toHaveTextContent('catch-up')
  })
})

describe('RunSummaryText', () => {
  it('renders markdown rather than showing its syntax', () => {
    render(<RunSummaryText text={'## Findings\n\nAll **clear**.'} kind="summary" />)
    expect(screen.getByRole('heading', { name: 'Findings' })).toBeInTheDocument()
    expect(screen.queryByText(/## Findings/)).not.toBeInTheDocument()
  })

  it('truncates a long summary out of the DOM until expanded', () => {
    // A real slice, not a CSS clamp: jsdom resolves no stylesheet, so a clamped string would
    // still be present here and this assertion could never fail.
    const tail = 'THE-TAIL'
    render(<RunSummaryText text={`${'x'.repeat(400)} ${tail}`} kind="summary" />)
    expect(screen.queryByText(new RegExp(tail))).not.toBeInTheDocument()

    fireEvent.click(screen.getByRole('button', { name: 'Show more' }))
    expect(screen.getByText(new RegExp(tail))).toBeInTheDocument()
  })

  it('does not offer a toggle for a short summary', () => {
    render(<RunSummaryText text="all clear" kind="summary" />)
    expect(screen.queryByRole('button')).not.toBeInTheDocument()
  })
})
