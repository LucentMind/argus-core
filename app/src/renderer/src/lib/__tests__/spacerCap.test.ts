// @vitest-environment jsdom
import { describe, it, expect, afterEach } from 'vitest'
import { maxSpacerPx, __setMaxSpacerPxForTests } from '../spacerCap'

describe('maxSpacerPx', () => {
  afterEach(() => __setMaxSpacerPxForTests(null))

  // A bad measurement is worse than no measurement: reading an overflow
  // container's scrollHeight at a narrow width returns 85px in Chromium, which
  // would clamp the viewer's spacer to a sliver and hide the whole file.
  it('never returns a collapsed height, even with no layout engine', () => {
    expect(maxSpacerPx()).toBeGreaterThan(1_000_000)
  })

  // The ceiling is counted in device px, so it must shrink as scaling grows —
  // a fixed fallback would sail past the real clamp on a scaled display.
  it('scales the fallback ceiling down with devicePixelRatio', () => {
    const at1 = maxSpacerPx()
    Object.defineProperty(window, 'devicePixelRatio', { value: 2, configurable: true })
    const at2 = maxSpacerPx()
    Object.defineProperty(window, 'devicePixelRatio', { value: 1, configurable: true })
    expect(at2).toBeLessThan(at1)
    expect(at2).toBeCloseTo(at1 / 2, -4)
  })

  it('caches per devicePixelRatio and honours the test override', () => {
    expect(maxSpacerPx()).toBe(maxSpacerPx())
    __setMaxSpacerPxForTests(4242)
    expect(maxSpacerPx()).toBe(4242)
    __setMaxSpacerPxForTests(null)
    expect(maxSpacerPx()).toBeGreaterThan(1_000_000)
  })
})
