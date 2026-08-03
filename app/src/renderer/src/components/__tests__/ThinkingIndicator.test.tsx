// @vitest-environment jsdom
import { render, screen, act } from '@testing-library/react'
import { describe, it, expect, vi, afterEach } from 'vitest'
import { ThinkingIndicator } from '../ThinkingIndicator'

// Decode timing (mirrors the component's constants): a character locks every
// RESOLVE_TICKS * TICK_MS = 135ms, so 'tracing' (7 chars) resolves in 945ms;
// the next word starts after a further HOLD_MS = 1400ms.
const CHAR_MS = 3 * 45
const HOLD_MS = 1400

// The glyph pool is katakana/digits/symbols — no lowercase latin — so the verb
// itself can never appear by scramble luck; seeing it means characters locked.
const scrambleText = (): string => screen.getByRole('status').textContent ?? ''

afterEach(() => {
  vi.useRealTimers()
  // matchMedia is stubbed per-test below; jsdom has no native one to restore
  delete (window as { matchMedia?: unknown }).matchMedia
})

describe('ThinkingIndicator', () => {
  it('decodes the verb out of glyph noise, then cycles to the next verb', () => {
    vi.useFakeTimers()
    render(<ThinkingIndicator />)
    expect(scrambleText()).not.toContain('tracing')

    act(() => {
      vi.advanceTimersByTime('tracing'.length * CHAR_MS)
    })
    expect(scrambleText()).toContain('tracing')

    // Two separate advances: the post-hold interval is created only when React
    // flushes effects at the end of an act(), so a single combined advance
    // would run the clock past ticks the new interval never saw.
    act(() => {
      vi.advanceTimersByTime(HOLD_MS)
    })
    act(() => {
      vi.advanceTimersByTime('probing'.length * CHAR_MS)
    })
    expect(scrambleText()).toContain('probing')
  })

  it('renders a static resolved verb with no timers under reduced motion', () => {
    window.matchMedia = vi.fn().mockReturnValue({ matches: true }) as never
    vi.useFakeTimers()
    render(<ThinkingIndicator />)
    expect(scrambleText()).toContain('tracing')
    expect(vi.getTimerCount()).toBe(0)
  })

  it('stops its timers on unmount', () => {
    vi.useFakeTimers()
    const { unmount } = render(<ThinkingIndicator />)
    expect(vi.getTimerCount()).toBeGreaterThan(0)
    unmount()
    expect(vi.getTimerCount()).toBe(0)
  })
})
