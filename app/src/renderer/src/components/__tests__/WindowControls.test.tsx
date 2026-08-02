// @vitest-environment jsdom
import '@testing-library/jest-dom/vitest'
import { render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { WindowControls } from '../WindowControls'

function stubArgus(
  platform: string,
  maximized = false
): { win: Record<string, ReturnType<typeof vi.fn>>; listeners: ((m: boolean) => void)[] } {
  const listeners: ((m: boolean) => void)[] = []
  const win = {
    minimize: vi.fn(async () => undefined),
    toggleMaximize: vi.fn(async () => undefined),
    close: vi.fn(async () => undefined),
    isMaximized: vi.fn(async () => maximized),
    onMaximizedChanged: vi.fn((cb: (m: boolean) => void) => {
      listeners.push(cb)
      return () => {
        listeners.splice(listeners.indexOf(cb), 1)
      }
    })
  }
  window.argus = { platform, window: win } as never
  return { win, listeners }
}

beforeEach(() => {
  stubArgus('win32')
})

describe('WindowControls', () => {
  it('renders nothing on darwin — the OS draws the traffic lights there', () => {
    stubArgus('darwin')
    const { container } = render(<WindowControls />)
    expect(container).toBeEmptyDOMElement()
  })

  it('minimizes on click', async () => {
    const { win } = stubArgus('win32')
    render(<WindowControls />)
    await userEvent.click(screen.getByTestId('window-minimize'))
    expect(win.minimize).toHaveBeenCalledTimes(1)
  })

  it('toggles maximize on click', async () => {
    const { win } = stubArgus('win32')
    render(<WindowControls />)
    await userEvent.click(screen.getByTestId('window-maximize'))
    expect(win.toggleMaximize).toHaveBeenCalledTimes(1)
  })

  it('leaves the label alone on click — only the OS maximized-changed event may move it', async () => {
    const { win } = stubArgus('win32', false)
    render(<WindowControls />)
    await waitFor(() =>
      expect(screen.getByTestId('window-maximize')).toHaveAttribute('aria-label', 'Maximize')
    )
    await userEvent.click(screen.getByTestId('window-maximize'))
    expect(win.toggleMaximize).toHaveBeenCalledTimes(1)
    // An optimistic local flip in the click handler (`setMaximized(true)` alongside the
    // `toggleMaximize()` call) would pass every other test in this file and still be wrong: the
    // OS can reject or coalesce the resize, and the real source of truth is `onMaximizedChanged`
    // (exercised below), not our own click. Flush toggleMaximize's stubbed promise first so a
    // `.then()`-based version of that same mistake gets the same chance to land before we check.
    await Promise.resolve()
    expect(screen.getByTestId('window-maximize')).toHaveAttribute('aria-label', 'Maximize')
  })

  it('closes on click', async () => {
    const { win } = stubArgus('win32')
    render(<WindowControls />)
    await userEvent.click(screen.getByTestId('window-close'))
    expect(win.close).toHaveBeenCalledTimes(1)
  })

  it('seeds the restore label from isMaximized()', async () => {
    stubArgus('win32', true)
    render(<WindowControls />)
    await waitFor(() =>
      expect(screen.getByTestId('window-maximize')).toHaveAttribute('aria-label', 'Restore')
    )
  })

  it('follows a maximize change the OS made, not just our own click', async () => {
    const { listeners } = stubArgus('win32', false)
    render(<WindowControls />)
    await waitFor(() =>
      expect(screen.getByTestId('window-maximize')).toHaveAttribute('aria-label', 'Maximize')
    )
    expect(listeners).toHaveLength(1)
    listeners[0](true)
    await waitFor(() =>
      expect(screen.getByTestId('window-maximize')).toHaveAttribute('aria-label', 'Restore')
    )
  })

  it('unsubscribes on unmount', async () => {
    const { listeners } = stubArgus('win32')
    const { unmount } = render(<WindowControls />)
    await waitFor(() => expect(listeners).toHaveLength(1))
    unmount()
    expect(listeners).toHaveLength(0)
  })

  it('opts every button out of the drag region', () => {
    render(<WindowControls />)
    for (const id of ['window-minimize', 'window-maximize', 'window-close']) {
      expect(screen.getByTestId(id).className).toContain('argus-nodrag')
    }
  })
})
