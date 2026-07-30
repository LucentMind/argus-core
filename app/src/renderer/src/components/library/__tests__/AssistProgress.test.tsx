// @vitest-environment jsdom
import '@testing-library/jest-dom/vitest'
import { describe, it, expect, vi, afterEach } from 'vitest'
import { render, screen, act } from '@testing-library/react'
import { AssistProgress } from '../AssistProgress'

afterEach(() => {
  vi.useRealTimers()
})

describe('AssistProgress', () => {
  it('starts at 0:00 and names the phase', () => {
    vi.useFakeTimers()
    render(<AssistProgress phase="draft" onStopWaiting={vi.fn()} />)
    expect(screen.getByRole('status')).toHaveTextContent('Drafting… 0:00')
  })

  it('names the improve phase', () => {
    vi.useFakeTimers()
    render(<AssistProgress phase="improve" onStopWaiting={vi.fn()} />)
    expect(screen.getByRole('status')).toHaveTextContent('Improving… 0:00')
  })

  it('advances the elapsed time and pads seconds past a minute', () => {
    vi.useFakeTimers()
    render(<AssistProgress phase="improve" onStopWaiting={vi.fn()} />)
    act(() => {
      vi.advanceTimersByTime(7_000)
    })
    expect(screen.getByRole('status')).toHaveTextContent('Improving… 0:07')
    act(() => {
      vi.advanceTimersByTime(56_000)
    })
    expect(screen.getByRole('status')).toHaveTextContent('Improving… 1:03')
  })

  it('shows the provider text when given one', () => {
    vi.useFakeTimers()
    render(
      <AssistProgress
        phase="draft"
        providerText="via claude-agent-sdk · claude-sonnet-4-5"
        onStopWaiting={vi.fn()}
      />
    )
    expect(screen.getByText(/via claude-agent-sdk · claude-sonnet-4-5/)).toBeInTheDocument()
  })

  it('calls onStopWaiting from a button labelled Stop waiting, not Cancel', async () => {
    const onStopWaiting = vi.fn()
    render(<AssistProgress phase="draft" onStopWaiting={onStopWaiting} />)
    expect(screen.queryByRole('button', { name: /^cancel$/i })).toBeNull()
    screen.getByRole('button', { name: /^stop waiting$/i }).click()
    expect(onStopWaiting).toHaveBeenCalledTimes(1)
  })

  it('clears its interval on unmount', () => {
    vi.useFakeTimers()
    const clear = vi.spyOn(globalThis, 'clearInterval')
    const { unmount } = render(<AssistProgress phase="draft" onStopWaiting={vi.fn()} />)
    unmount()
    expect(clear).toHaveBeenCalled()
    clear.mockRestore()
  })
})
