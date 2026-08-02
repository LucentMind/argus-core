import { describe, it, expect } from 'vitest'
import { BANDS } from '../ambientBands'
// react-refresh/only-export-components forbids a component file from
// exporting anything but components, so hexToRgb01 lives in its own module
// (see [[argus-renderer-lint-traps]]) — AmbientCanvas.tsx imports it from here.
import { hexToRgb01 } from '../hexColor'
import { TITLEBAR_HEIGHTS } from '../../../../shared/titleBarHeights'

describe('BANDS', () => {
  it('home keeps the shipped blob geometry', () => {
    expect(BANDS.home).toEqual({ pad: [320, 145], feather: 110, mode: 0, extra: 50, fade: 24 })
  })

  it('case and settings are ribbons with a band-sized feather', () => {
    expect(BANDS.case.mode).toBe(1)
    expect(BANDS.settings.mode).toBe(1)
    // A feather taller than the band it fades erases the band: home's shipped 110px would
    // wipe out anything this short. `case` is the chrome strip now — the title strip plus
    // TopBar's h-12 — not the 44px header band it fitted before the header merge, so the
    // ceiling moved with it. Measured off the shared constant, so a title-strip resize can't
    // silently invalidate the number.
    expect(BANDS.case.feather).toBeLessThan(TITLEBAR_HEIGHTS.main + 48)
    expect(BANDS.settings.feather).toBeLessThan(BANDS.home.feather)
  })

  it('the case band fades past its cutoff rather than stopping dead at it', () => {
    // The inverse of what this asserted while the case aurora was a separate layer mounted
    // behind the bar. That layer had to die exactly at the bar's bottom edge, because the page
    // below painted its own opaque ground over any tail and turned the fade into a hard clipped
    // edge. There is one canvas now, spanning the chrome AND the view below it, so the tail
    // lands on the same surface the rest of the band does and a fade is a fade.
    expect(BANDS.case.extra).toBeGreaterThan(0)
    expect(BANDS.case.fade).toBeGreaterThan(0)
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
