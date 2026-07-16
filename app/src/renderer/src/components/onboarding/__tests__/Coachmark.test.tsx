// @vitest-environment jsdom
import { act, render, screen } from '@testing-library/react'
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { Coachmark } from '../Coachmark'

describe('Coachmark', () => {
  beforeEach(() => {
    vi.useFakeTimers()
    vi.stubGlobal('requestAnimationFrame', (cb: FrameRequestCallback) => setTimeout(() => cb(0), 0))
    vi.stubGlobal('cancelAnimationFrame', (id: number) => clearTimeout(id))
  })

  afterEach(() => {
    vi.unstubAllGlobals()
    vi.useRealTimers()
  })

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

    // Even after the bounded retry window elapses, it must settle on the
    // fallback rather than throwing or leaving stale timers behind.
    act(() => {
      vi.runAllTimers()
    })
    expect(screen.getByText('fallback')).toBeTruthy()
    expect(screen.queryByTestId('coachmark-ring')).toBeNull()
  })

  it('resolves the ring once the anchor mounts after initial render', () => {
    render(
      <Coachmark anchor="late">
        <span>late-target</span>
      </Coachmark>
    )
    // Nothing in the DOM yet: renders the centered fallback first.
    expect(screen.getByText('late-target')).toBeTruthy()
    expect(screen.queryByTestId('coachmark-ring')).toBeNull()

    const target = document.createElement('button')
    target.setAttribute('data-onboarding-anchor', 'late')
    target.getBoundingClientRect = () =>
      ({
        top: 200,
        left: 60,
        width: 90,
        height: 30,
        right: 150,
        bottom: 230,
        x: 60,
        y: 200,
        toJSON: () => ({})
      }) as DOMRect
    document.body.appendChild(target)

    // Let the bounded rAF retry loop catch up to the newly-mounted anchor.
    act(() => {
      vi.advanceTimersByTime(0)
    })

    const ring = screen.getByTestId('coachmark-ring')
    expect(ring.style.top).toBe('200px')
    expect(ring.style.left).toBe('60px')

    document.body.removeChild(target)
  })
})
