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
  it('is true only for a running rollup', () => {
    expect(anyRunning([status({ rollup: 'running' })])).toBe(true)
    expect(anyRunning([status({ rollup: 'failing' }), status({ rollup: 'passing' })])).toBe(false)
    expect(anyRunning([null])).toBe(false)
    expect(anyRunning([])).toBe(false)
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

    statusRefresh.mockResolvedValueOnce({ c1: status({ rollup: 'running' }) })
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
    statusRefresh.mockResolvedValueOnce({ c1: status({ rollup: 'running' }) })
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
    statusRefresh.mockResolvedValue({ c1: status({ rollup: 'running' }) })
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
