import { describe, it, expect } from 'vitest'
import { scrollFractionOf, scrollTopForFraction } from '../scrollSync'

describe('scrollFractionOf', () => {
  it('maps scrollTop onto 0–1 over the scrollable range', () => {
    expect(scrollFractionOf({ scrollTop: 0, scrollHeight: 1000, clientHeight: 500 })).toBe(0)
    expect(scrollFractionOf({ scrollTop: 250, scrollHeight: 1000, clientHeight: 500 })).toBe(0.5)
    expect(scrollFractionOf({ scrollTop: 500, scrollHeight: 1000, clientHeight: 500 })).toBe(1)
  })

  it('reports 0 for content that does not scroll', () => {
    // Division by a zero range is the whole reason this is a function and not an inline
    // expression: a short document would otherwise send NaN into the other pane's scrollTop,
    // which silently pins it at 0 forever.
    expect(scrollFractionOf({ scrollTop: 0, scrollHeight: 400, clientHeight: 500 })).toBe(0)
  })

  it('clamps overscroll, which macOS reports as a negative scrollTop', () => {
    expect(scrollFractionOf({ scrollTop: -40, scrollHeight: 1000, clientHeight: 500 })).toBe(0)
    expect(scrollFractionOf({ scrollTop: 900, scrollHeight: 1000, clientHeight: 500 })).toBe(1)
  })
})

describe('scrollTopForFraction', () => {
  it('maps a fraction back onto the target range', () => {
    expect(scrollTopForFraction({ scrollHeight: 2000, clientHeight: 500 }, 0.5)).toBe(750)
  })

  it('returns 0 for a target that does not scroll', () => {
    expect(scrollTopForFraction({ scrollHeight: 300, clientHeight: 500 }, 0.5)).toBe(0)
  })

  it('round-trips through a pane of a different height, which is the point', () => {
    const editor = { scrollTop: 250, scrollHeight: 1000, clientHeight: 500 }
    const preview = { scrollHeight: 3000, clientHeight: 500 }
    expect(scrollTopForFraction(preview, scrollFractionOf(editor))).toBe(1250)
  })
})
