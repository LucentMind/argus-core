// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { ModeSwitcher } from '../ModeSwitcher'

const available = vi.fn()
const setMode = vi.fn()

beforeEach(() => {
  available.mockReset()
  setMode.mockReset().mockResolvedValue({ sessionId: 42 })
  ;(globalThis as unknown as { window: { argus: unknown } }).window.argus = {
    modes: { available },
    cases: { setMode }
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
