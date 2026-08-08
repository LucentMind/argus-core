// @vitest-environment jsdom
import { renderHook, waitFor, act } from '@testing-library/react'
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { useRoutinesPayload, routinesStore } from '../routinesStore'
import type { RoutinesPayload } from '../../../../shared/routines'

function payload(over: Partial<RoutinesPayload> = {}): RoutinesPayload {
  return {
    routines: [],
    loadError: null,
    runningId: null,
    queued: [],
    nextRunAt: {},
    unreviewedCount: 0,
    runs: [],
    ...over
  }
}

let listeners: Array<() => void>

beforeEach(() => {
  listeners = []
  routinesStore.reset()
  window.argus = {
    routines: {
      list: vi.fn(async () => payload({ unreviewedCount: 2 })),
      onChanged: vi.fn((cb: () => void) => {
        listeners.push(cb)
        return () => {}
      })
    }
  } as never
})

describe('useRoutinesPayload', () => {
  it('loads on mount', async () => {
    const { result } = renderHook(() => useRoutinesPayload())
    await waitFor(() => expect(result.current.payload?.unreviewedCount).toBe(2))
  })

  it('reloads on the payload-free broadcast', async () => {
    const { result } = renderHook(() => useRoutinesPayload())
    await waitFor(() => expect(result.current.payload).not.toBeNull())
    ;(window.argus.routines.list as ReturnType<typeof vi.fn>).mockResolvedValue(
      payload({ unreviewedCount: 0 })
    )

    act(() => listeners.forEach((l) => l()))

    await waitFor(() => expect(result.current.payload?.unreviewedCount).toBe(0))
  })

  it('surfaces a load failure instead of hanging on null', async () => {
    ;(window.argus.routines.list as ReturnType<typeof vi.fn>).mockRejectedValue(new Error('boom'))
    const { result } = renderHook(() => useRoutinesPayload())
    await waitFor(() => expect(result.current.error).toBe('boom'))
  })
})
