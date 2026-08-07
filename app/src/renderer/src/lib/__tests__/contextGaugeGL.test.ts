// @vitest-environment jsdom
import { describe, it, expect } from 'vitest'
import { createGaugeRenderer, parseToneColor } from '../contextGaugeGL'

describe('parseToneColor', () => {
  it('reads the computed colour forms a browser actually hands back', () => {
    // getComputedStyle().color is normalised to rgb()/rgba() by every engine that matters, but
    // the hex branch keeps an inline `color: #8bdca5` working too.
    expect(parseToneColor('rgb(139, 220, 165)')).toEqual([139 / 255, 220 / 255, 165 / 255])
    expect(parseToneColor('rgb(139 220 165)')).toEqual([139 / 255, 220 / 255, 165 / 255])
    expect(parseToneColor('rgba(242, 122, 107, 0.4)')).toEqual([242 / 255, 122 / 255, 107 / 255])
    expect(parseToneColor('#8bdca5')).toEqual([139 / 255, 220 / 255, 165 / 255])
  })

  it('refuses anything it cannot actually read rather than inventing a colour', () => {
    // The caller skips the frame on null. Guessing here would paint the gauge in the wrong
    // status colour — a green ridge on a failed session — which is worse than not painting.
    expect(parseToneColor('color-mix(in oklab, currentColor 40%, transparent)')).toBeNull()
    expect(parseToneColor('oklch(0.86 0.12 150)')).toBeNull()
    expect(parseToneColor('')).toBeNull()
    expect(parseToneColor('#8bd')).toBeNull()
  })
})

describe('createGaugeRenderer', () => {
  it('reports itself unavailable where WebGL2 is missing, and never throws', () => {
    // jsdom returns null from getContext('webgl2'). This is the same shape a lost GPU process
    // presents, and it is what routes every consumer to the CSS gradient.
    const r = createGaugeRenderer()
    expect(r.available()).toBe(false)
    const cv = document.createElement('canvas')
    cv.width = 94
    cv.height = 19
    expect(() =>
      r.render(cv, {
        w: 94,
        h: 19,
        t: 0,
        fill: 0.5,
        amp: 0.06,
        scale: 1.1,
        warp: 1.2,
        glow: 1,
        ech: 2,
        light: false,
        tone: [0.5, 0.8, 0.6]
      })
    ).not.toThrow()
  })

  it('allocates nothing at all where WebGL2 is absent, however often it is asked', () => {
    // available() runs on every render of every pill. Probing by actually calling
    // getContext('webgl2') costs a canvas each time AND makes jsdom log "Not implemented" into
    // every renderer test run — the constructor check answers the same question for free.
    let made = 0
    const orig = document.createElement.bind(document)
    const spy = ((tag: string, ...rest: unknown[]) => {
      if (tag === 'canvas') made++
      return orig(tag as 'canvas', ...(rest as []))
    }) as typeof document.createElement
    document.createElement = spy
    try {
      const r = createGaugeRenderer()
      expect(r.available()).toBe(false)
      expect(r.available()).toBe(false)
      expect(r.available()).toBe(false)
      expect(made).toBe(0)
    } finally {
      document.createElement = orig
    }
  })
})
