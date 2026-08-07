import { describe, it, expect } from 'vitest'
import {
  closeWindow,
  isWindowFullScreen,
  isWindowMaximized,
  minimizeWindow,
  toggleMaximizeWindow,
  type ControllableWindow
} from '../windowControls'

class FakeWindow implements ControllableWindow {
  destroyed = false
  maximized = false
  fullScreen = false
  calls: string[] = []
  isDestroyed(): boolean {
    return this.destroyed
  }
  isMaximized(): boolean {
    return this.maximized
  }
  isFullScreen(): boolean {
    return this.fullScreen
  }
  minimize(): void {
    this.calls.push('minimize')
  }
  maximize(): void {
    this.calls.push('maximize')
    this.maximized = true
  }
  unmaximize(): void {
    this.calls.push('unmaximize')
    this.maximized = false
  }
  close(): void {
    this.calls.push('close')
  }
}

describe('windowControls', () => {
  it('minimizes', () => {
    const win = new FakeWindow()
    minimizeWindow(win)
    expect(win.calls).toEqual(['minimize'])
  })

  it('maximizes a restored window', () => {
    const win = new FakeWindow()
    toggleMaximizeWindow(win)
    expect(win.calls).toEqual(['maximize'])
    expect(win.maximized).toBe(true)
  })

  it('restores a maximized window', () => {
    const win = new FakeWindow()
    win.maximized = true
    toggleMaximizeWindow(win)
    expect(win.calls).toEqual(['unmaximize'])
    expect(win.maximized).toBe(false)
  })

  it('closes', () => {
    const win = new FakeWindow()
    closeWindow(win)
    expect(win.calls).toEqual(['close'])
  })

  it('reports maximized state', () => {
    const win = new FakeWindow()
    expect(isWindowMaximized(win)).toBe(false)
    win.maximized = true
    expect(isWindowMaximized(win)).toBe(true)
  })

  // The macOS header inset keys off this: full screen hides the traffic lights, so the ~78px
  // reserved for them has to come back.
  it('reports full-screen state', () => {
    const win = new FakeWindow()
    expect(isWindowFullScreen(win)).toBe(false)
    win.fullScreen = true
    expect(isWindowFullScreen(win)).toBe(true)
  })

  it('is inert on a null window', () => {
    expect(() => minimizeWindow(null)).not.toThrow()
    expect(() => toggleMaximizeWindow(null)).not.toThrow()
    expect(() => closeWindow(null)).not.toThrow()
    expect(isWindowMaximized(null)).toBe(false)
    expect(isWindowFullScreen(null)).toBe(false)
  })

  it('is inert on a destroyed window — a click can land after the window is gone', () => {
    const win = new FakeWindow()
    win.destroyed = true
    minimizeWindow(win)
    toggleMaximizeWindow(win)
    closeWindow(win)
    expect(win.calls).toEqual([])
    expect(isWindowMaximized(win)).toBe(false)
    win.fullScreen = true
    expect(isWindowFullScreen(win)).toBe(false)
  })
})
