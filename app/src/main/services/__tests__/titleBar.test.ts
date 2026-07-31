import { describe, it, expect } from 'vitest'
import {
  applyOverlay,
  overlayFor,
  titleBarWindowOptions,
  type OverlayWindow,
  type TitleBarOverlay
} from '../titleBar'

/** Records every overlay push. Mirrors the FakeEditorWindow pattern in editorWindow.test.ts. */
class FakeWindow implements OverlayWindow {
  destroyed = false
  overlays: TitleBarOverlay[] = []
  isDestroyed(): boolean {
    return this.destroyed
  }
  setTitleBarOverlay = (o: TitleBarOverlay): void => {
    this.overlays.push(o)
  }
}

describe('overlayFor', () => {
  it('pairs the theme surface with the window kind height', () => {
    expect(overlayFor('main', 'dark')).toEqual({
      color: '#0a0a0b',
      symbolColor: '#efede6',
      height: 64
    })
    expect(overlayFor('editor', 'light')).toEqual({
      color: '#faf8f3',
      symbolColor: '#18181b',
      height: 40
    })
  })
})

describe('titleBarWindowOptions', () => {
  it('hides the frame and carries the full overlay on Windows', () => {
    const opts = titleBarWindowOptions('main', 'dark', 'win32')
    expect(opts.titleBarStyle).toBe('hidden')
    expect(opts.titleBarOverlay).toEqual({
      color: '#0a0a0b',
      symbolColor: '#efede6',
      height: 64
    })
    // Without this the frame flashes white between creation and first paint.
    expect(opts.backgroundColor).toBe('#0a0a0b')
  })

  it('sends only a height on macOS, where the traffic lights are not ours to colour', () => {
    expect(titleBarWindowOptions('editor', 'light', 'darwin').titleBarOverlay).toEqual({
      height: 40
    })
  })
})

describe('applyOverlay', () => {
  it('re-tints a live window', () => {
    const win = new FakeWindow()
    applyOverlay(win, 'editor', 'light')
    expect(win.overlays).toEqual([{ color: '#faf8f3', symbolColor: '#18181b', height: 40 }])
  })

  it('is a no-op on a null or destroyed window', () => {
    const win = new FakeWindow()
    win.destroyed = true
    applyOverlay(win, 'main', 'dark')
    applyOverlay(null, 'main', 'dark')
    expect(win.overlays).toEqual([])
  })

  it('is a no-op where setTitleBarOverlay does not exist (macOS)', () => {
    const mac: OverlayWindow = { isDestroyed: () => false }
    expect(() => applyOverlay(mac, 'main', 'dark')).not.toThrow()
  })
})
