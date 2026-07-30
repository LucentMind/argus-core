// @vitest-environment jsdom
import { renderHook, act } from '@testing-library/react'
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { usePendingDisplay } from '../usePendingDisplay'

beforeEach(() => {
  vi.useFakeTimers()
})
afterEach(() => {
  vi.useRealTimers()
})

describe('usePendingDisplay', () => {
  it('never shows when the work finishes inside the delay window', () => {
    const { result, rerender } = renderHook(({ a }) => usePendingDisplay(a), {
      initialProps: { a: true }
    })
    act(() => {
      vi.advanceTimersByTime(100)
    })
    expect(result.current).toBe(false)

    rerender({ a: false })
    act(() => {
      vi.advanceTimersByTime(5000)
    })
    expect(result.current).toBe(false)
  })

  it('shows once the delay elapses', () => {
    const { result } = renderHook(() => usePendingDisplay(true))
    expect(result.current).toBe(false)
    act(() => {
      vi.advanceTimersByTime(150)
    })
    expect(result.current).toBe(true)
  })

  it('holds the minimum display time after the work finishes', () => {
    const { result, rerender } = renderHook(({ a }) => usePendingDisplay(a), {
      initialProps: { a: true }
    })
    act(() => {
      vi.advanceTimersByTime(150)
    })
    expect(result.current).toBe(true)

    // finishes immediately after appearing — must stay up for the 300ms minimum
    rerender({ a: false })
    act(() => {
      vi.advanceTimersByTime(299)
    })
    expect(result.current).toBe(true)
    act(() => {
      vi.advanceTimersByTime(1)
    })
    expect(result.current).toBe(false)
  })

  it('hides immediately when the minimum has already been served', () => {
    const { result, rerender } = renderHook(({ a }) => usePendingDisplay(a), {
      initialProps: { a: true }
    })
    act(() => {
      vi.advanceTimersByTime(150 + 400)
    })
    expect(result.current).toBe(true)

    rerender({ a: false })
    act(() => {
      vi.advanceTimersByTime(0)
    })
    expect(result.current).toBe(false)
  })

  it('honours custom delay and minimum', () => {
    const { result } = renderHook(() => usePendingDisplay(true, 50, 100))
    act(() => {
      vi.advanceTimersByTime(49)
    })
    expect(result.current).toBe(false)
    act(() => {
      vi.advanceTimersByTime(1)
    })
    expect(result.current).toBe(true)
  })
})
