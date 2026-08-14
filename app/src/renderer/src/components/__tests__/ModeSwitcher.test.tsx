// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { ModeSwitcher } from '../ModeSwitcher'

const available = vi.fn()
const setMode = vi.fn()

const onWorkspacesChanged = vi.fn()
let fireWorkspacesChanged: ((slug: string) => void) | undefined

beforeEach(() => {
  available.mockReset()
  setMode.mockReset().mockResolvedValue({ sessionId: 42 })
  fireWorkspacesChanged = undefined
  onWorkspacesChanged.mockReset().mockImplementation((cb: (slug: string) => void) => {
    fireWorkspacesChanged = cb
    return () => undefined
  })
  ;(globalThis as unknown as { window: { argus: unknown } }).window.argus = {
    modes: { available },
    cases: { setMode },
    workspaces: { onChanged: onWorkspacesChanged }
  }
})

describe('ModeSwitcher', () => {
  it('shows both modes when review is available and switches on click', async () => {
    available.mockResolvedValue(['investigation', 'review'])
    const onModeChanged = vi.fn()
    const onError = vi.fn()
    render(
      <ModeSwitcher
        slug="c1"
        activeMode="investigation"
        onModeChanged={onModeChanged}
        onError={onError}
      />
    )
    const reviewBtn = await screen.findByRole('button', { name: /review/i })
    await userEvent.click(reviewBtn)
    await waitFor(() => expect(setMode).toHaveBeenCalledWith('c1', 'review'))
    expect(onModeChanged).toHaveBeenCalledWith('review', 42)
    expect(onError).not.toHaveBeenCalled()
  })

  it('renders investigation as the only, non-switchable mode today', async () => {
    available.mockResolvedValue(['investigation'])
    render(
      <ModeSwitcher
        slug="c1"
        activeMode="investigation"
        onModeChanged={vi.fn()}
        onError={vi.fn()}
      />
    )
    await waitFor(() => expect(available).toHaveBeenCalled())
    expect(screen.queryByRole('button', { name: /review/i })).toBeNull()
    expect(screen.getByText('Investigation')).toBeTruthy()
  })

  it('surfaces a modes.available load failure via onError instead of an unhandled rejection', async () => {
    available.mockRejectedValue(new Error('boom'))
    const onError = vi.fn()
    render(
      <ModeSwitcher
        slug="c1"
        activeMode="investigation"
        onModeChanged={vi.fn()}
        onError={onError}
      />
    )
    await waitFor(() =>
      expect(onError).toHaveBeenCalledWith('Could not load available modes for this case.')
    )
  })

  // Availability became user-mutable in Plan 2 (it counts linked repos), so a list fetched
  // once at mount goes stale the moment a repo is linked or unlinked — offering a Review
  // button that the main process then rejects, or hiding one that is now legitimate.
  it('refetches availability when the case gains a repo, without a remount', async () => {
    available.mockResolvedValue(['investigation'])
    render(
      <ModeSwitcher
        slug="c1"
        activeMode="investigation"
        onModeChanged={vi.fn()}
        onError={vi.fn()}
      />
    )
    await waitFor(() => expect(available).toHaveBeenCalledTimes(1))
    expect(screen.queryByRole('button', { name: /review/i })).toBeNull()

    available.mockResolvedValue(['investigation', 'review'])
    fireWorkspacesChanged!('c1')
    expect(await screen.findByRole('button', { name: /review/i })).toBeTruthy()
  })

  it('drops a Review button that a repo unlink just invalidated', async () => {
    available.mockResolvedValue(['investigation', 'review'])
    render(
      <ModeSwitcher
        slug="c1"
        activeMode="investigation"
        onModeChanged={vi.fn()}
        onError={vi.fn()}
      />
    )
    await screen.findByRole('button', { name: /review/i })

    available.mockResolvedValue(['investigation'])
    fireWorkspacesChanged!('c1')
    await waitFor(() => expect(screen.queryByRole('button', { name: /review/i })).toBeNull())
  })

  it('ignores a workspaces:changed broadcast for a different case', async () => {
    available.mockResolvedValue(['investigation', 'review'])
    render(
      <ModeSwitcher
        slug="c1"
        activeMode="investigation"
        onModeChanged={vi.fn()}
        onError={vi.fn()}
      />
    )
    await waitFor(() => expect(available).toHaveBeenCalledTimes(1))
    fireWorkspacesChanged!('OTHER')
    await new Promise((r) => setTimeout(r, 0))
    expect(available).toHaveBeenCalledTimes(1)
  })

  // The switch is slow on purpose (review entry fetches PR worktrees, then searches GitHub).
  // aria-pressed still may NOT flip early — the parent owns that — so busy is the only
  // honest immediate feedback, and without it the UI reads as frozen.
  it('marks the pending mode busy while the switch is in flight, without faking pressed', async () => {
    available.mockResolvedValue(['investigation', 'review'])
    let resolve!: (v: { sessionId: number }) => void
    setMode.mockReset().mockReturnValue(
      new Promise<{ sessionId: number }>((r) => {
        resolve = r
      })
    )
    render(
      <ModeSwitcher
        slug="c1"
        activeMode="investigation"
        onModeChanged={vi.fn()}
        onError={vi.fn()}
      />
    )
    const reviewBtn = await screen.findByRole('button', { name: /review/i })
    await userEvent.click(reviewBtn)

    await waitFor(() => expect(reviewBtn.getAttribute('aria-busy')).toBe('true'))
    expect(reviewBtn.getAttribute('aria-pressed')).toBe('false') // no optimistic mirror

    resolve({ sessionId: 42 })
    await waitFor(() => expect(reviewBtn.getAttribute('aria-busy')).toBe('false'))
  })

  /**
   * Inverted deliberately. This used to assert the opposite — that the parent could drive
   * `busyMode`/`statusText` to keep the control spinning past its own await, for review's PR
   * search. Those props are gone: the switch is over once `cases.setMode` resolves (the
   * worktree checkout no longer sits inside it either — see setCaseMode's `materialized`), and
   * the search reports in the Pull request rail. Busy here now means, and only means, that a
   * switch is genuinely in flight.
   */
  it('is not busy on a settled switch, whatever the parent is doing', async () => {
    available.mockResolvedValue(['investigation', 'review'])
    render(<ModeSwitcher slug="c1" activeMode="review" onModeChanged={vi.fn()} onError={vi.fn()} />)
    const reviewBtn = await screen.findByRole('button', { name: /case mode · review/i })
    expect(reviewBtn.getAttribute('aria-busy')).toBe('false')
    expect(reviewBtn.getAttribute('title')).toBeNull()
  })

  it('puts the switch status on the busy button title, not in a sibling element', async () => {
    available.mockResolvedValue(['investigation', 'review'])
    setMode.mockReset().mockReturnValue(new Promise(() => {}))
    const user = userEvent.setup()
    render(
      <ModeSwitcher
        slug="case-a"
        activeMode="investigation"
        onModeChanged={() => {}}
        onError={() => {}}
      />
    )
    const review = await screen.findByRole('button', { name: 'Case mode · Review' })
    await user.click(review)
    await waitFor(() => expect(review.getAttribute('title')).toBe('Switching to Review…'))
    // the free-floating status span is what shoved the rest of the bar sideways
    expect(screen.queryByRole('status')).toBeNull()
  })

  it('ignores repeat clicks while a switch is already in flight', async () => {
    available.mockResolvedValue(['investigation', 'review'])
    setMode.mockReset().mockReturnValue(new Promise(() => {}))
    render(
      <ModeSwitcher
        slug="c1"
        activeMode="investigation"
        onModeChanged={vi.fn()}
        onError={vi.fn()}
      />
    )
    const reviewBtn = await screen.findByRole('button', { name: /review/i })
    await userEvent.click(reviewBtn)
    await userEvent.click(reviewBtn)
    expect(setMode).toHaveBeenCalledTimes(1)
  })

  it('surfaces a rejected setMode via onError instead of a silent no-op click', async () => {
    available.mockResolvedValue(['investigation', 'review'])
    setMode.mockReset().mockRejectedValue(new Error('boom'))
    const onModeChanged = vi.fn()
    const onError = vi.fn()
    render(
      <ModeSwitcher
        slug="c1"
        activeMode="investigation"
        onModeChanged={onModeChanged}
        onError={onError}
      />
    )
    const reviewBtn = await screen.findByRole('button', { name: /review/i })
    await userEvent.click(reviewBtn)
    await waitFor(() =>
      expect(onError).toHaveBeenCalledWith('Could not switch mode for this chat.')
    )
    expect(onModeChanged).not.toHaveBeenCalled()
  })
})
