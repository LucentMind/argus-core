// @vitest-environment jsdom
import { describe, it, expect, beforeEach, vi, afterEach } from 'vitest'
import '@testing-library/jest-dom/vitest'
import { render, screen, act } from '@testing-library/react'
import { anyRunning, prStatusStore, usePrStatuses } from '../prStatusStore'
import type { PrStatus } from '../../../../shared/prStatus'

const status = (over: Partial<PrStatus> = {}): PrStatus => ({
  owner: 'acme',
  repo: 'widget',
  number: 42,
  url: 'https://github.com/acme/widget/pull/42',
  state: 'OPEN',
  isDraft: false,
  mergeable: 'MERGEABLE',
  mergeStateStatus: 'CLEAN',
  reviewDecision: null,
  rollup: 'passing',
  checks: [],
  fetchedAt: '2026-07-27T12:00:00.000Z',
  error: null,
  ...over
})

let statusList: ReturnType<typeof vi.fn>
let statusRefresh: ReturnType<typeof vi.fn>
let unsubscribe: ReturnType<typeof vi.fn>

beforeEach(() => {
  vi.useFakeTimers()
  prStatusStore.hydrate({})
  statusList = vi.fn(async () => ({}))
  statusRefresh = vi.fn(async () => ({ c1: status() }))
  unsubscribe = vi.fn()
  ;(window as unknown as { argus: unknown }).argus = {
    pr: {
      statusList,
      statusRefresh,
      onStatusChanged: () => unsubscribe
    }
  }
})

afterEach(() => {
  vi.useRealTimers()
})

function Probe({ slugs, interval }: { slugs: string[]; interval: number }): React.JSX.Element {
  const map = usePrStatuses(slugs, interval)
  return (
    <div data-testid="rollups">{slugs.map((s) => `${s}:${map[s]?.rollup ?? '-'}`).join(' ')}</div>
  )
}

describe('anyRunning', () => {
  it('is true when any check is pending', () => {
    const pending = [
      { name: 'build', bucket: 'pending' as const, required: false, url: null, jobId: null }
    ]
    const done = [
      { name: 'build', bucket: 'pass' as const, required: false, url: null, jobId: null }
    ]

    expect(anyRunning([status({ rollup: 'running', checks: pending })])).toBe(true)
    expect(anyRunning([status({ rollup: 'passing', checks: done })])).toBe(false)
    // The point of the change: a red or amber dot with jobs still in flight keeps the fast
    // cadence, where reading the rollup would have idled it.
    expect(anyRunning([status({ rollup: 'failing', checks: [...done, ...pending] })])).toBe(true)
    expect(anyRunning([status({ rollup: 'unstable', checks: [...done, ...pending] })])).toBe(true)
    expect(anyRunning([null])).toBe(false)
    expect(anyRunning([])).toBe(false)
  })
})

describe('forget', () => {
  it('drops a cached slug and notifies subscribers', () => {
    prStatusStore.hydrate({ c1: status(), c2: status() })
    const cb = vi.fn()
    const off = prStatusStore.subscribe(cb)

    prStatusStore.forget('c1')

    expect(prStatusStore.get('c1')).toBeNull()
    expect(prStatusStore.get('c2')).not.toBeNull()
    expect(cb).toHaveBeenCalledTimes(1)
    off()
  })

  it('is a no-op when the slug is not cached', () => {
    prStatusStore.hydrate({ c2: status() })
    const cb = vi.fn()
    const off = prStatusStore.subscribe(cb)

    prStatusStore.forget('c1')

    expect(cb).not.toHaveBeenCalled()
    off()
  })
})

describe('usePrStatuses', () => {
  it('loads the cache and refreshes once on mount', async () => {
    render(<Probe slugs={['c1']} interval={20_000} />)
    await act(async () => {})
    expect(statusList).toHaveBeenCalledWith(['c1'])
    expect(statusRefresh).toHaveBeenCalledTimes(1)
    expect(screen.getByTestId('rollups')).toHaveTextContent('c1:passing')
  })

  it('keeps a slow heartbeat when nothing is running', async () => {
    // NOT "does not poll": stopping outright is what let a restarted CI run go unnoticed
    // indefinitely (see IDLE_POLL_MULTIPLIER). Idling is the fix.
    render(<Probe slugs={['c1']} interval={20_000} />)
    await act(async () => {})
    expect(statusRefresh).toHaveBeenCalledTimes(1)

    // Still quiet one fast interval in — the idle cadence must be slower, not merely non-zero.
    await act(async () => {
      vi.advanceTimersByTime(20_000)
    })
    expect(statusRefresh).toHaveBeenCalledTimes(1)

    await act(async () => {
      vi.advanceTimersByTime(40_000)
    })
    expect(statusRefresh).toHaveBeenCalledTimes(2)
  })

  it('discovers a run that starts after everything had settled', async () => {
    // The exact defect: terminal -> running was undiscoverable, because discovering it needed
    // the poll that all-terminal had switched off.
    render(<Probe slugs={['c1']} interval={20_000} />)
    await act(async () => {})
    expect(screen.getByTestId('rollups')).toHaveTextContent('c1:passing')

    const pending = [
      { name: 'build', bucket: 'pending' as const, required: false, url: null, jobId: null }
    ]
    statusRefresh.mockResolvedValueOnce({ c1: status({ rollup: 'running', checks: pending }) })
    await act(async () => {
      vi.advanceTimersByTime(60_000)
    })
    expect(screen.getByTestId('rollups')).toHaveTextContent('c1:running')

    // and having found work, it goes back to the fast cadence
    await act(async () => {
      vi.advanceTimersByTime(20_000)
    })
    expect(statusRefresh).toHaveBeenCalledTimes(3)
  })

  it('polls fast while a check is running and slows once it settles', async () => {
    const pending = [
      { name: 'build', bucket: 'pending' as const, required: false, url: null, jobId: null }
    ]
    statusRefresh.mockResolvedValueOnce({ c1: status({ rollup: 'running', checks: pending }) })
    render(<Probe slugs={['c1']} interval={20_000} />)
    await act(async () => {})
    expect(statusRefresh).toHaveBeenCalledTimes(1)

    // still running -> the fast interval is armed
    await act(async () => {
      vi.advanceTimersByTime(20_000)
    })
    expect(statusRefresh).toHaveBeenCalledTimes(2)
    expect(screen.getByTestId('rollups')).toHaveTextContent('c1:passing')

    // that second refresh returned passing -> the fast interval must no longer fire
    await act(async () => {
      vi.advanceTimersByTime(20_000)
    })
    expect(statusRefresh).toHaveBeenCalledTimes(2)

    // ...but the idle one does
    await act(async () => {
      vi.advanceTimersByTime(40_000)
    })
    expect(statusRefresh).toHaveBeenCalledTimes(3)
  })

  it('makes no call at all for an empty slug list', async () => {
    render(<Probe slugs={[]} interval={20_000} />)
    await act(async () => {})
    expect(statusList).not.toHaveBeenCalled()
    expect(statusRefresh).not.toHaveBeenCalled()
  })

  it('stops polling on unmount', async () => {
    const pending = [
      { name: 'build', bucket: 'pending' as const, required: false, url: null, jobId: null }
    ]
    statusRefresh.mockResolvedValue({ c1: status({ rollup: 'running', checks: pending }) })
    const view = render(<Probe slugs={['c1']} interval={20_000} />)
    await act(async () => {})
    const before = statusRefresh.mock.calls.length
    view.unmount()
    await act(async () => {
      vi.advanceTimersByTime(120_000)
    })
    expect(statusRefresh).toHaveBeenCalledTimes(before)
  })

  it('survives a refresh that rejects and retries at the idle cadence', async () => {
    statusRefresh.mockRejectedValueOnce(new Error('gh exploded'))
    render(<Probe slugs={['c1']} interval={20_000} />)
    await act(async () => {})
    expect(screen.getByTestId('rollups')).toHaveTextContent('c1:-')
    expect(statusRefresh).toHaveBeenCalledTimes(1)

    // One transient IPC failure must not blind the surface for the life of the mount — that is
    // the same defect as stopping at all-terminal, with a rarer trigger.
    await act(async () => {
      vi.advanceTimersByTime(60_000)
    })
    expect(statusRefresh).toHaveBeenCalledTimes(2)
    expect(screen.getByTestId('rollups')).toHaveTextContent('c1:passing')
  })
})

describe('prStatusStore.isLoaded', () => {
  it('is false before load and true after, even when the case has no bound PR', async () => {
    expect(prStatusStore.isLoaded('C-9')).toBe(false)
    window.argus.pr.statusList = vi.fn(async () => ({}))
    await prStatusStore.load(['C-9'])
    expect(prStatusStore.isLoaded('C-9')).toBe(true)
  })

  it('stays true after forget — an unlinked case is known to have no PR', async () => {
    window.argus.pr.statusList = vi.fn(async () => ({}))
    await prStatusStore.load(['C-10'])
    prStatusStore.forget('C-10')
    expect(prStatusStore.isLoaded('C-10')).toBe(true)
  })

  it('is true even when the cache read rejects', async () => {
    window.argus.pr.statusList = vi.fn(async () => {
      throw new Error('ipc down')
    })
    await expect(prStatusStore.load(['C-11'])).rejects.toThrow('ipc down')
    expect(prStatusStore.isLoaded('C-11')).toBe(true)
  })
})
