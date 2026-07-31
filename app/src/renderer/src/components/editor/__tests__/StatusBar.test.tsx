// @vitest-environment jsdom
import { describe, it, expect, vi } from 'vitest'
import { render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import '@testing-library/jest-dom/vitest'
import { StatusBar } from '../StatusBar'

const base = {
  cursor: { line: 12, col: 3, selected: 0 },
  issues: [],
  sync: 'saved' as const,
  draftAt: null,
  viewMode: 'editor' as const,
  onProblems: vi.fn(),
  onCycleViewMode: vi.fn()
}

describe('StatusBar', () => {
  it('shows the cursor position', () => {
    render(<StatusBar {...base} />)
    expect(screen.getByText('12:3')).toBeInTheDocument()
  })

  it('shows a selection size only when there is one', () => {
    const { rerender } = render(<StatusBar {...base} />)
    expect(screen.queryByText(/selected/)).not.toBeInTheDocument()
    rerender(<StatusBar {...base} cursor={{ line: 12, col: 3, selected: 42 }} />)
    expect(screen.getByText('42 selected')).toBeInTheDocument()
  })

  it('names the sync state, and dates the draft', () => {
    const { rerender } = render(<StatusBar {...base} />)
    expect(screen.getByText('Saved')).toBeInTheDocument()
    rerender(<StatusBar {...base} sync="draft" draftAt="2026-07-31T15:42:00.000Z" />)
    expect(screen.getByText(/^Draft ·/)).toBeInTheDocument()
    rerender(<StatusBar {...base} sync="conflict" />)
    expect(screen.getByText('Conflict')).toBeInTheDocument()
  })

  it('opens the problems panel from the counts', async () => {
    const onProblems = vi.fn()
    render(
      <StatusBar
        {...base}
        onProblems={onProblems}
        issues={[
          { severity: 'error', message: 'a' },
          { severity: 'warning', message: 'b' }
        ]}
      />
    )
    await userEvent.click(screen.getByRole('button', { name: /1 error, 1 warning/i }))
    expect(onProblems).toHaveBeenCalled()
  })

  it('hides the counts entirely when the file is clean', () => {
    render(<StatusBar {...base} />)
    expect(screen.queryByRole('button', { name: /error|warning/i })).not.toBeInTheDocument()
  })

  it('cycles the view mode from its own control', async () => {
    const onCycleViewMode = vi.fn()
    render(<StatusBar {...base} viewMode="split" onCycleViewMode={onCycleViewMode} />)
    const button = screen.getByRole('button', { name: /view mode: split/i })
    await userEvent.click(button)
    expect(onCycleViewMode).toHaveBeenCalled()
  })

  it('shows a tier badge only when a tier is known', () => {
    const { rerender } = render(<StatusBar {...base} />)
    // Increment 4 supplies this; until then there is no tier to show and the slot stays empty
    // rather than guessing (see deviation 1).
    expect(screen.queryByTestId('tier-badge')).not.toBeInTheDocument()
    rerender(<StatusBar {...base} tier="bundled" />)
    expect(screen.getByTestId('tier-badge')).toHaveTextContent('bundled')
  })
})
