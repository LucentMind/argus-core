import { describe, it, expect } from 'vitest'
import {
  applyOverlay,
  overlayFor,
  pushScaleIfChanged,
  pushThemeIfChanged,
  titleBarWindowOptions,
  type EditorChrome,
  type OverlayWindow,
  type TitleBarOverlay,
  type TitleBarTheme
} from '../titleBar'
import { TITLEBAR_HEIGHTS } from '../../../shared/titleBarHeights'

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

/** A fake editor-side target for `pushThemeIfChanged`/`pushScaleIfChanged`. Mirrors the
 *  FakeEditorWindow pattern in editorWindow.test.ts, but only the two methods this module
 *  drives — it is not a full EditorWindowHandle. */
class FakeEditor implements EditorChrome {
  themes: TitleBarTheme[] = []
  scales: number[] = []
  applyTheme(theme: TitleBarTheme): void {
    this.themes.push(theme)
  }
  applyScale(scale: number): void {
    this.scales.push(scale)
  }
}

describe('overlayFor', () => {
  it('pairs the theme surface with the window kind height, from the shared constant', () => {
    expect(overlayFor('main', 'dark')).toEqual({
      color: '#0a0a0b',
      symbolColor: '#efede6',
      height: TITLEBAR_HEIGHTS.main
    })
    expect(overlayFor('editor', 'light')).toEqual({
      color: '#faf8f3',
      symbolColor: '#18181b',
      height: TITLEBAR_HEIGHTS.editor
    })
  })

  it('defaults scale to 1', () => {
    expect(overlayFor('main', 'dark').height).toBe(TITLEBAR_HEIGHTS.main)
  })

  it('scales the height and rounds, for a shrink (0.9) and a grow (1.5)', () => {
    // 32 * 0.9 = 28.8 -> 29; 32 * 1.5 = 48 exactly.
    expect(overlayFor('main', 'dark', 0.9).height).toBe(29)
    expect(overlayFor('main', 'dark', 1.5).height).toBe(48)
    // 40 * 0.9 = 36 exactly; 40 * 1.5 = 60 exactly.
    expect(overlayFor('editor', 'light', 0.9).height).toBe(36)
    expect(overlayFor('editor', 'light', 1.5).height).toBe(60)
  })
})

describe('titleBarWindowOptions', () => {
  it('hides the frame and carries the full overlay on Windows', () => {
    const opts = titleBarWindowOptions('main', 'dark', 'win32')
    expect(opts.titleBarStyle).toBe('hidden')
    expect(opts.titleBarOverlay).toEqual({
      color: '#0a0a0b',
      symbolColor: '#efede6',
      height: TITLEBAR_HEIGHTS.main
    })
    // Without this the frame flashes white between creation and first paint.
    expect(opts.backgroundColor).toBe('#0a0a0b')
  })

  it('sends only a height on macOS, where the traffic lights are not ours to colour', () => {
    expect(titleBarWindowOptions('editor', 'light', 'darwin').titleBarOverlay).toEqual({
      height: TITLEBAR_HEIGHTS.editor
    })
  })

  it('defaults scale to 1', () => {
    expect(titleBarWindowOptions('main', 'dark', 'win32').titleBarOverlay).toEqual(
      titleBarWindowOptions('main', 'dark', 'win32', 1).titleBarOverlay
    )
  })

  it('scales the overlay height passed to the window constructor', () => {
    const opts = titleBarWindowOptions('editor', 'dark', 'win32', 1.5)
    expect(opts.titleBarOverlay).toEqual({ color: '#0a0a0b', symbolColor: '#efede6', height: 60 })
  })
})

describe('applyOverlay', () => {
  it('re-tints a live window', () => {
    const win = new FakeWindow()
    applyOverlay(win, 'editor', 'light')
    expect(win.overlays).toEqual([
      { color: '#faf8f3', symbolColor: '#18181b', height: TITLEBAR_HEIGHTS.editor }
    ])
  })

  it('scales the height it re-tints with, defaulting to 1', () => {
    const win = new FakeWindow()
    applyOverlay(win, 'main', 'dark', 0.9)
    expect(win.overlays).toEqual([{ color: '#0a0a0b', symbolColor: '#efede6', height: 29 }])
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

// index.ts's `panels:set-theme` / `ui:set-scale` IPC handlers cannot be imported under vitest —
// the module boots Electron at import time. `pushThemeIfChanged`/`pushScaleIfChanged` hold the
// decision logic those handlers delegate to, so the "assign before pushing, skip when unchanged"
// fix (review issue 6 — the in-diff suspect for the live width-zero defect) has a seam a test can
// drive with fakes instead of a real BrowserWindow.
describe('pushThemeIfChanged', () => {
  it('pushes the new overlay to both windows when the theme actually changed', () => {
    const win = new FakeWindow()
    const editor = new FakeEditor()
    const changed = pushThemeIfChanged(win, editor, 'light', 'dark', 1)
    expect(changed).toBe(true)
    expect(win.overlays).toEqual([
      { color: '#faf8f3', symbolColor: '#18181b', height: TITLEBAR_HEIGHTS.main }
    ])
    expect(editor.themes).toEqual(['light'])
  })

  it('skips both windows when the reported theme matches what main already knew', () => {
    const win = new FakeWindow()
    const editor = new FakeEditor()
    const changed = pushThemeIfChanged(win, editor, 'dark', 'dark', 1)
    expect(changed).toBe(false)
    expect(win.overlays).toEqual([])
    expect(editor.themes).toEqual([])
  })

  it('carries the current scale into the pushed overlay', () => {
    const win = new FakeWindow()
    const changed = pushThemeIfChanged(win, null, 'light', 'dark', 1.5)
    expect(changed).toBe(true)
    expect(win.overlays).toEqual([{ color: '#faf8f3', symbolColor: '#18181b', height: 48 }])
  })

  it('tolerates a null editor target (editor window not open)', () => {
    const win = new FakeWindow()
    expect(() => pushThemeIfChanged(win, null, 'light', 'dark', 1)).not.toThrow()
  })
})

describe('pushScaleIfChanged', () => {
  it('pushes the rescaled overlay to both windows when the scale actually changed', () => {
    const win = new FakeWindow()
    const editor = new FakeEditor()
    const changed = pushScaleIfChanged(win, editor, 0.9, 1, 'dark')
    expect(changed).toBe(true)
    expect(win.overlays).toEqual([{ color: '#0a0a0b', symbolColor: '#efede6', height: 29 }])
    expect(editor.scales).toEqual([0.9])
  })

  it('skips both windows when the reported scale matches what main already knew', () => {
    const win = new FakeWindow()
    const editor = new FakeEditor()
    const changed = pushScaleIfChanged(win, editor, 1, 1, 'dark')
    expect(changed).toBe(false)
    expect(win.overlays).toEqual([])
    expect(editor.scales).toEqual([])
  })

  it('carries the current theme into the pushed overlay', () => {
    const win = new FakeWindow()
    const changed = pushScaleIfChanged(win, null, 1.5, 1, 'light')
    expect(changed).toBe(true)
    expect(win.overlays).toEqual([{ color: '#faf8f3', symbolColor: '#18181b', height: 48 }])
  })

  it('tolerates a null editor target (editor window not open)', () => {
    const win = new FakeWindow()
    expect(() => pushScaleIfChanged(win, null, 1.5, 1, 'dark')).not.toThrow()
  })
})
