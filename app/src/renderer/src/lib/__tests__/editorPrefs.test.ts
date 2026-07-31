// @vitest-environment jsdom
import { describe, it, expect, beforeEach } from 'vitest'
import {
  clampFontSize,
  clampSplitFraction,
  FONT_DEFAULT,
  FONT_MAX,
  FONT_MIN,
  nextViewMode,
  readPrefs,
  writePrefs
} from '../editorPrefs'

beforeEach(() => localStorage.clear())

describe('clampFontSize', () => {
  it('holds the bounds', () => {
    expect(clampFontSize(FONT_MIN - 5)).toBe(FONT_MIN)
    expect(clampFontSize(FONT_MAX + 5)).toBe(FONT_MAX)
    expect(clampFontSize(15)).toBe(15)
  })

  it('rejects a non-finite size rather than propagating NaN into a theme', () => {
    expect(clampFontSize(Number.NaN)).toBe(FONT_DEFAULT)
  })
})

describe('nextViewMode', () => {
  it('cycles editor → split → preview → editor', () => {
    expect(nextViewMode('editor')).toBe('split')
    expect(nextViewMode('split')).toBe('preview')
    expect(nextViewMode('preview')).toBe('editor')
  })
})

describe('clampSplitFraction', () => {
  it('keeps both panes usable', () => {
    expect(clampSplitFraction(0.01)).toBe(0.2)
    expect(clampSplitFraction(0.99)).toBe(0.8)
    expect(clampSplitFraction(0.5)).toBe(0.5)
  })
})

describe('readPrefs / writePrefs', () => {
  it('returns the defaults when nothing is stored', () => {
    expect(readPrefs()).toEqual({
      fontSize: FONT_DEFAULT,
      wrap: true,
      viewMode: 'editor',
      splitFraction: 0.5
    })
  })

  it('round-trips a patch without disturbing the other keys', () => {
    writePrefs({ fontSize: 18 })
    writePrefs({ viewMode: 'split' })
    expect(readPrefs()).toEqual({
      fontSize: 18,
      wrap: true,
      viewMode: 'split',
      splitFraction: 0.5
    })
  })

  it('falls back to defaults on corrupt or out-of-range stored values', () => {
    localStorage.setItem('argus.editor.fontSize', 'enormous')
    localStorage.setItem('argus.editor.viewMode', 'hologram')
    localStorage.setItem('argus.editor.splitFraction', '4')
    const prefs = readPrefs()
    expect(prefs.fontSize).toBe(FONT_DEFAULT)
    expect(prefs.viewMode).toBe('editor')
    expect(prefs.splitFraction).toBe(0.8)
  })
})
