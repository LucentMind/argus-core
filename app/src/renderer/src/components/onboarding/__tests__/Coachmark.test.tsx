// @vitest-environment jsdom
import { render, screen } from '@testing-library/react'
import { describe, it, expect } from 'vitest'
import { Coachmark } from '../Coachmark'

describe('Coachmark', () => {
  it('positions a ring over the anchored element', () => {
    const target = document.createElement('button')
    target.setAttribute('data-onboarding-anchor', 'x')
    target.getBoundingClientRect = () =>
      ({
        top: 100,
        left: 40,
        width: 80,
        height: 24,
        right: 120,
        bottom: 124,
        x: 40,
        y: 100,
        toJSON: () => ({})
      }) as DOMRect
    document.body.appendChild(target)
    render(
      <Coachmark anchor="x">
        <span>hello</span>
      </Coachmark>
    )
    expect(screen.getByText('hello')).toBeTruthy()
    const ring = screen.getByTestId('coachmark-ring')
    expect(ring.style.top).toBe('100px')
    expect(ring.style.left).toBe('40px')
    document.body.removeChild(target)
  })

  it('falls back to centered when the anchor is missing', () => {
    render(
      <Coachmark anchor="does-not-exist">
        <span>fallback</span>
      </Coachmark>
    )
    expect(screen.getByText('fallback')).toBeTruthy()
    expect(screen.queryByTestId('coachmark-ring')).toBeNull()
  })
})
