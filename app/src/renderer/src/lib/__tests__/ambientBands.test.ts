import { describe, it, expect } from 'vitest'
import { BANDS } from '../ambientBands'
// react-refresh/only-export-components forbids a component file from
// exporting anything but components, so hexToRgb01 lives in its own module
// (see [[argus-renderer-lint-traps]]) — AmbientCanvas.tsx imports it from here.
import { hexToRgb01 } from '../hexColor'

describe('BANDS', () => {
  it('home keeps the shipped blob geometry', () => {
    expect(BANDS.home).toEqual({ pad: [320, 145], feather: 110, mode: 0, extra: 50, fade: 24 })
  })

  it('case and settings are ribbons with a band-sized feather', () => {
    expect(BANDS.case.mode).toBe(1)
    expect(BANDS.settings.mode).toBe(1)
    // the shipped 110px fade starts above a 44px-tall band and erases it
    expect(BANDS.case.feather).toBeLessThan(44)
  })

  it('every variant keeps fade within the canvas — fade must not exceed extra, or the low edge of the confine band runs off the bottom of the canvas and leaves a hard seam', () => {
    for (const variant of Object.values(BANDS)) {
      expect(variant.fade).toBeLessThanOrEqual(variant.extra)
    }
  })
})

describe('hexToRgb01', () => {
  it('parses 6-digit hex', () => {
    expect(hexToRgb01('#ffffff')).toEqual([1, 1, 1])
  })

  it('parses 3-digit hex — the shipped version returned black here', () => {
    expect(hexToRgb01('#fff')).toEqual([1, 1, 1])
  })

  it('returns null on malformed input rather than a silent black', () => {
    expect(hexToRgb01('rgb(1,2,3)')).toBeNull()
    expect(hexToRgb01('')).toBeNull()
  })
})
