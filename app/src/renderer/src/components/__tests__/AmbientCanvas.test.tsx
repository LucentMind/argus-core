// @vitest-environment jsdom
import { render } from '@testing-library/react'
import { describe, it, expect } from 'vitest'
import { AmbientCanvas } from '../AmbientCanvas'
import { anchorRect } from '../../lib/anchorRect'
import { BANDS } from '../../lib/ambientBands'

describe('AmbientCanvas', () => {
  // jsdom has no WebGL: getContext('webgl2') returns null (or throws in some
  // configs). This test doubles as the real-world no-WebGL fallback check.
  it('renders the CSS fallback and does not throw when WebGL is unavailable', () => {
    const { getByTestId, queryByTestId } = render(
      <AmbientCanvas light={null} cutoff={null} theme="dark" band={BANDS.home} />
    )
    expect(getByTestId('ambient-fallback')).toBeTruthy()
    expect(queryByTestId('ambient-canvas')).toBeNull()
  })

  it('fallback is inert decoration: aria-hidden, pointer-events handled by CSS', () => {
    const { getByTestId } = render(
      <AmbientCanvas light={null} cutoff={null} theme="light" band={BANDS.home} />
    )
    expect(getByTestId('ambient-fallback').getAttribute('aria-hidden')).toBe('true')
  })
})

describe('anchorRect', () => {
  it('returns the viewport rect when nothing is scrolled', () => {
    const el = document.createElement('div')
    el.getBoundingClientRect = () =>
      ({ x: 10, y: 20, width: 100, height: 30, bottom: 50 }) as DOMRect
    document.body.appendChild(el)
    expect(anchorRect(el)).toEqual({ x: 10, y: 20, width: 100, height: 30, bottom: 50 })
  })

  it("adds ancestors' scrollTop back, so a resize taken mid-scroll does not move the light", () => {
    const scroller = document.createElement('div')
    const el = document.createElement('div')
    scroller.appendChild(el)
    document.body.appendChild(scroller)
    Object.defineProperty(scroller, 'scrollTop', { value: 200, configurable: true })
    el.getBoundingClientRect = () =>
      ({ x: 0, y: -120, width: 100, height: 30, bottom: -90 }) as DOMRect
    // measured at -120 because the page is scrolled 200px; at rest it sits at 80.
    expect(anchorRect(el)).toMatchObject({ y: 80, bottom: 110 })
  })

  it('accumulates scrollTop across nested scrollers', () => {
    const outer = document.createElement('div')
    const inner = document.createElement('div')
    const el = document.createElement('div')
    outer.appendChild(inner)
    inner.appendChild(el)
    document.body.appendChild(outer)
    Object.defineProperty(outer, 'scrollTop', { value: 30, configurable: true })
    Object.defineProperty(inner, 'scrollTop', { value: 12, configurable: true })
    el.getBoundingClientRect = () => ({ x: 0, y: 0, width: 1, height: 1, bottom: 1 }) as DOMRect
    expect(anchorRect(el)).toMatchObject({ y: 42, bottom: 43 })
  })
})
