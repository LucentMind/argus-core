import { describe, it, expect, vi } from 'vitest'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import {
  applyOverlay,
  overlayFor,
  pushScaleIfChanged,
  pushThemeIfChanged,
  titleBarWindowOptions,
  type OverlayWindow,
  type TitleBarOverlay
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

describe('overlayFor', () => {
  it('pairs the theme surface with the window kind height, from the shared constant', () => {
    expect(overlayFor('main', 'dark')).toEqual({
      color: '#0a0a0b',
      symbolColor: '#efede6',
      height: TITLEBAR_HEIGHTS.main
    })
    expect(overlayFor('editor', 'light')).toEqual({
      color: '#eef2f9',
      symbolColor: '#101823',
      height: TITLEBAR_HEIGHTS.editor
    })
  })

  it('defaults scale to 1', () => {
    expect(overlayFor('main', 'dark').height).toBe(TITLEBAR_HEIGHTS.main)
  })

  /**
   * titleBar.ts's PALETTE is a hand-copy of the renderer's `--bg-1` / `--ink` (main cannot read
   * the renderer's stylesheet), and it silently drifted once: the light redesign moved theme.css
   * to the cool `#eef2f9` wash while this copy kept the old warm-paper `#faf8f3`, so the OS
   * min/max/close cluster rendered on a different surface than the strip it sits in. Nothing
   * caught it — every assertion in this file compared the copy against itself. This reads the
   * stylesheet the copy claims to mirror and holds the two together.
   */
  it('mirrors theme.css — the copy this module admits it is', () => {
    const css = readFileSync(join(__dirname, '../../../renderer/src/assets/theme.css'), 'utf8')
    /** The value of `name` inside the first `selector { … }` block. */
    const tokenIn = (selector: string, name: string): string => {
      const open = css.indexOf('{', css.indexOf(selector))
      const body = css.slice(open + 1, css.indexOf('}', open))
      const hit = new RegExp(`^\\s*${name}:\\s*([^;]+);`, 'm').exec(body)
      if (!hit) throw new Error(`${name} not found in ${selector}`)
      return hit[1].trim()
    }
    expect(overlayFor('main', 'dark').color).toBe(tokenIn(':root {', '--bg-1'))
    expect(overlayFor('main', 'dark').symbolColor).toBe(tokenIn(':root {', '--ink'))
    expect(overlayFor('main', 'light').color).toBe(tokenIn(":root[data-theme='light'] {", '--bg-1'))
    expect(overlayFor('main', 'light').symbolColor).toBe(
      tokenIn(":root[data-theme='light'] {", '--ink')
    )
  })

  it('scales the height and rounds, for a shrink (0.9) and a grow (1.5)', () => {
    // 48 * 0.9 = 43.2 -> 43; 48 * 1.5 = 72 exactly.
    expect(overlayFor('main', 'dark', 0.9).height).toBe(43)
    expect(overlayFor('main', 'dark', 1.5).height).toBe(72)
    // 40 * 0.9 = 36 exactly; 40 * 1.5 = 60 exactly.
    expect(overlayFor('editor', 'light', 0.9).height).toBe(36)
    expect(overlayFor('editor', 'light', 1.5).height).toBe(60)
  })
})

describe('titleBarWindowOptions', () => {
  it('sends only a height on macOS, where the traffic lights are not ours to colour', () => {
    expect(titleBarWindowOptions('editor', 'light', 'darwin').titleBarOverlay).toEqual({
      height: TITLEBAR_HEIGHTS.editor
    })
  })

  it('scales the overlay height passed to the window constructor', () => {
    const opts = titleBarWindowOptions('editor', 'dark', 'win32', 1.5)
    expect(opts.titleBarOverlay).toEqual({ color: '#0a0a0b', symbolColor: '#efede6', height: 60 })
  })
})

describe('titleBarWindowOptions · main window', () => {
  it('emits NO overlay on win32 — the header draws its own caption buttons', () => {
    const opts = titleBarWindowOptions('main', 'dark', 'win32')
    expect(opts.titleBarStyle).toBe('hidden')
    expect(opts.titleBarOverlay).toBeUndefined()
    expect(opts.backgroundColor).toBe('#0a0a0b')
  })

  it('emits NO overlay on linux either', () => {
    expect(titleBarWindowOptions('main', 'light', 'linux').titleBarOverlay).toBeUndefined()
  })

  it("keeps a height-only overlay on darwin — the traffic lights are the OS's", () => {
    // 48 = TITLEBAR_HEIGHTS.main, the header height, so the lights centre on the header.
    expect(titleBarWindowOptions('main', 'dark', 'darwin').titleBarOverlay).toEqual({ height: 48 })
  })

  it('ignores scale on win32 — there is no native hit-box left to size', () => {
    expect(titleBarWindowOptions('main', 'dark', 'win32', 1.5).titleBarOverlay).toBeUndefined()
  })

  it('still scales the darwin overlay height', () => {
    expect(titleBarWindowOptions('main', 'dark', 'darwin', 1.5).titleBarOverlay).toEqual({
      height: 72
    })
  })
})

describe('applyOverlay', () => {
  it('re-tints a live window', () => {
    const win = new FakeWindow()
    applyOverlay(win, 'editor', 'light')
    expect(win.overlays).toEqual([
      { color: '#eef2f9', symbolColor: '#101823', height: TITLEBAR_HEIGHTS.editor }
    ])
  })

  it('scales the height it re-tints with, defaulting to 1', () => {
    const win = new FakeWindow()
    applyOverlay(win, 'editor', 'dark', 0.9)
    expect(win.overlays).toEqual([{ color: '#0a0a0b', symbolColor: '#efede6', height: 36 }])
  })

  it('is a no-op on a null or destroyed window', () => {
    const win = new FakeWindow()
    win.destroyed = true
    applyOverlay(win, 'editor', 'dark')
    applyOverlay(null, 'editor', 'dark')
    expect(win.overlays).toEqual([])
  })

  it('is a no-op where setTitleBarOverlay does not exist (macOS)', () => {
    const mac: OverlayWindow = { isDestroyed: () => false }
    expect(() => applyOverlay(mac, 'editor', 'dark')).not.toThrow()
  })
})

describe('pushThemeIfChanged', () => {
  it('pushes to the editor window only, and only on a real change', () => {
    const editor = { applyTheme: vi.fn(), applyScale: vi.fn() }
    expect(pushThemeIfChanged(editor, 'light', 'dark')).toBe(true)
    expect(editor.applyTheme).toHaveBeenCalledWith('light')
  })

  it('is a no-op when the theme did not change', () => {
    const editor = { applyTheme: vi.fn(), applyScale: vi.fn() }
    expect(pushThemeIfChanged(editor, 'dark', 'dark')).toBe(false)
    expect(editor.applyTheme).not.toHaveBeenCalled()
  })

  it('tolerates a null editor', () => {
    expect(() => pushThemeIfChanged(null, 'light', 'dark')).not.toThrow()
  })
})

describe('pushScaleIfChanged', () => {
  it('pushes to the editor window only, and only on a real change', () => {
    const editor = { applyTheme: vi.fn(), applyScale: vi.fn() }
    expect(pushScaleIfChanged(editor, 1.25, 1)).toBe(true)
    expect(editor.applyScale).toHaveBeenCalledWith(1.25)
  })

  it('is a no-op when the scale did not change', () => {
    const editor = { applyTheme: vi.fn(), applyScale: vi.fn() }
    expect(pushScaleIfChanged(editor, 1, 1)).toBe(false)
    expect(editor.applyScale).not.toHaveBeenCalled()
  })
})
