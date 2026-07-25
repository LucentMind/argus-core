// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { ModeSwitcher } from '../ModeSwitcher'

const available = vi.fn()
const setMode = vi.fn()

beforeEach(() => {
  available.mockReset()
  setMode.mockReset().mockResolvedValue(true)
  ;(globalThis as unknown as { window: { argus: unknown } }).window.argus = {
    modes: { available },
    sessions: { setMode }
  }
})

describe('ModeSwitcher', () => {
  it('shows both modes when review is available and switches on click', async () => {
    available.mockResolvedValue(['investigation', 'review'])
    const onModeChanged = vi.fn()
    render(
      <ModeSwitcher
        slug="c1"
        sessionId={5}
        activeMode="investigation"
        onModeChanged={onModeChanged}
      />
    )
    const reviewBtn = await screen.findByRole('button', { name: /review/i })
    await userEvent.click(reviewBtn)
    await waitFor(() => expect(setMode).toHaveBeenCalledWith(5, 'review'))
    expect(onModeChanged).toHaveBeenCalledWith('review')
  })

  it('renders investigation as the only, non-switchable mode today', async () => {
    available.mockResolvedValue(['investigation'])
    render(
      <ModeSwitcher slug="c1" sessionId={5} activeMode="investigation" onModeChanged={vi.fn()} />
    )
    await waitFor(() => expect(available).toHaveBeenCalled())
    expect(screen.queryByRole('button', { name: /review/i })).toBeNull()
  })
})
