// @vitest-environment jsdom
import '@testing-library/jest-dom/vitest'
import { describe, it, expect, vi } from 'vitest'
import { render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { FindingRejectStrip } from '../FindingRejectStrip'

describe('FindingRejectStrip', () => {
  it('a chip sends its tag, with the note when one is typed', async () => {
    const onPick = vi.fn()
    render(<FindingRejectStrip onPick={onPick} onSkip={vi.fn()} />)
    await userEvent.click(screen.getByRole('button', { name: 'Reject as wrong' }))
    expect(onPick).toHaveBeenCalledWith({ tag: 'wrong' })
    await userEvent.type(screen.getByRole('textbox', { name: 'Reject note' }), 'old build')
    await userEvent.click(screen.getByRole('button', { name: 'Reject as not-useful' }))
    expect(onPick).toHaveBeenLastCalledWith({ tag: 'not-useful', note: 'old build' })
  })
  it('Enter in the note, or the Reject button, sends other + note', async () => {
    const onPick = vi.fn()
    render(<FindingRejectStrip onPick={onPick} onSkip={vi.fn()} />)
    expect(screen.queryByRole('button', { name: 'Reject with this note' })).not.toBeInTheDocument()
    await userEvent.type(
      screen.getByRole('textbox', { name: 'Reject note' }),
      'restates the ticket{enter}'
    )
    expect(onPick).toHaveBeenCalledWith({ tag: 'other', note: 'restates the ticket' })
    await userEvent.click(screen.getByRole('button', { name: 'Reject with this note' }))
    expect(onPick).toHaveBeenCalledTimes(2)
  })
  it('Skip and Escape close without sending', async () => {
    const onPick = vi.fn()
    const onSkip = vi.fn()
    render(<FindingRejectStrip onPick={onPick} onSkip={onSkip} />)
    await userEvent.click(screen.getByRole('button', { name: 'Skip' }))
    await userEvent.keyboard('{Escape}')
    expect(onSkip).toHaveBeenCalledTimes(2)
    expect(onPick).not.toHaveBeenCalled()
  })
  it('offers Correct… when given a handler, and not otherwise', async () => {
    const onCorrect = vi.fn()
    const { rerender } = render(
      <FindingRejectStrip onPick={vi.fn()} onSkip={vi.fn()} onCorrect={onCorrect} />
    )
    await userEvent.click(screen.getByRole('button', { name: 'Correct this finding in chat' }))
    expect(onCorrect).toHaveBeenCalled()
    rerender(<FindingRejectStrip onPick={vi.fn()} onSkip={vi.fn()} />)
    expect(screen.queryByRole('button', { name: 'Correct this finding in chat' })).toBeNull()
  })
})
