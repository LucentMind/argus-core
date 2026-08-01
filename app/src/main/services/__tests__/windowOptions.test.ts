import { describe, it, expect } from 'vitest'
import { editorWindowOptions, mainWindowOptions } from '../windowOptions'
import { TITLEBAR_HEIGHTS } from '../../../shared/titleBarHeights'

/**
 * The literal keys `createWindow()` (index.ts) still writes at the call site, alongside the
 * spread of `mainWindowOptions(...)` — none of these vary with theme/scale/icon/preload, so they
 * never moved into the extracted function. A key collision here would mean the spread silently
 * clobbers (or gets clobbered by) one of these.
 */
const MAIN_CALL_SITE_SIBLING_KEYS = [
  'width',
  'height',
  'minWidth',
  'minHeight',
  'show',
  'autoHideMenuBar'
]

/** Same idea for `makeElectronEditorWindowFactory` (electronEditorWindow.ts) — `width`/`height`/
 *  `x`/`y` come from `clampToDisplays`'s already-computed bounds, so they stay at the call site. */
const EDITOR_CALL_SITE_SIBLING_KEYS = [
  'width',
  'height',
  'x',
  'y',
  'minWidth',
  'minHeight',
  'show',
  'autoHideMenuBar',
  'title'
]

describe('mainWindowOptions', () => {
  it('hides the frame', () => {
    const opts = mainWindowOptions('dark', 1, '/argus-icon.png', '/preload/index.js', 'win32')
    expect(opts.titleBarStyle).toBe('hidden')
  })

  it('carries the overlay for the given theme and scale, at the main strip height', () => {
    const opts = mainWindowOptions('dark', 1.5, '/argus-icon.png', '/preload/index.js', 'win32')
    expect(opts.titleBarOverlay).toEqual({
      color: '#0a0a0b',
      symbolColor: '#efede6',
      height: Math.round(TITLEBAR_HEIGHTS.main * 1.5)
    })
  })

  it('carries the light-theme overlay colors', () => {
    const opts = mainWindowOptions('light', 1, '/argus-icon.png', '/preload/index.js', 'win32')
    expect(opts.titleBarOverlay).toEqual({
      color: '#faf8f3',
      symbolColor: '#18181b',
      height: TITLEBAR_HEIGHTS.main
    })
  })

  it('sends only a height on macOS', () => {
    const opts = mainWindowOptions('dark', 1, '/argus-icon.png', '/preload/index.js', 'darwin')
    expect(opts.titleBarOverlay).toEqual({ height: TITLEBAR_HEIGHTS.main })
  })

  it('passes the icon path and preload path straight through', () => {
    const opts = mainWindowOptions('dark', 1, '/argus-icon.png', '/preload/index.js', 'win32')
    expect(opts.icon).toBe('/argus-icon.png')
    expect(opts.webPreferences).toEqual({ preload: '/preload/index.js', sandbox: false })
  })

  it('introduces no key that collides with the sibling literal options at the call site', () => {
    const opts = mainWindowOptions('dark', 1, '/argus-icon.png', '/preload/index.js', 'win32')
    for (const key of MAIN_CALL_SITE_SIBLING_KEYS) {
      expect(Object.keys(opts)).not.toContain(key)
    }
  })
})

describe('editorWindowOptions', () => {
  it('hides the frame', () => {
    const opts = editorWindowOptions('dark', 1, '/preload/index.js', 'win32')
    expect(opts.titleBarStyle).toBe('hidden')
  })

  it('carries the overlay for the given theme and scale, at the editor strip height', () => {
    const opts = editorWindowOptions('light', 0.9, '/preload/index.js', 'win32')
    expect(opts.titleBarOverlay).toEqual({
      color: '#faf8f3',
      symbolColor: '#18181b',
      height: Math.round(TITLEBAR_HEIGHTS.editor * 0.9)
    })
  })

  it('passes the preload path straight through', () => {
    const opts = editorWindowOptions('dark', 1, '/preload/index.js', 'win32')
    expect(opts.webPreferences).toEqual({ preload: '/preload/index.js', sandbox: false })
  })

  it('introduces no key that collides with the sibling literal options at the call site', () => {
    const opts = editorWindowOptions('dark', 1, '/preload/index.js', 'win32')
    for (const key of EDITOR_CALL_SITE_SIBLING_KEYS) {
      expect(Object.keys(opts)).not.toContain(key)
    }
  })
})
