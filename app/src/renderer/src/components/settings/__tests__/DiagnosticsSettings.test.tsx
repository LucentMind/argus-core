// @vitest-environment jsdom
import '@testing-library/jest-dom/vitest'
import { describe, it, expect, beforeEach, vi } from 'vitest'
import { render, screen, act, within, fireEvent } from '@testing-library/react'
import DiagnosticsSettings, { STOP_PENDING_TIMEOUT_MS } from '../DiagnosticsSettings'
import type {
  DiagnosticsHistory,
  DiagnosticsObject,
  DiagnosticsSnapshot
} from '../../../../../shared/diagnostics'

vi.mock('../../../lib/confirmStore', () => ({
  confirm: vi.fn(() => Promise.resolve(true)),
  alert: vi.fn(() => Promise.resolve())
}))
import { confirm, alert } from '../../../lib/confirmStore'

let onSampleCb: (s: DiagnosticsSnapshot) => void = () => {}
let unsubscribeCalls = 0
let historyCalls: number[] = []
let terminateMock = vi.fn()
let historyResult: DiagnosticsHistory = emptyHistory()

function objectRow(over: Partial<DiagnosticsObject> = {}): DiagnosticsObject {
  return {
    id: '2:1000',
    kind: 'mcp',
    label: 'MCP: demo',
    orphan: false,
    inferred: false,
    terminable: true,
    busy: false,
    rootPid: 2,
    processCount: 1,
    cpuPercent: 0.5,
    rssBytes: 1_000,
    uptimeMs: 60_000,
    ...over
  }
}

function emptyHistory(bucketCount = 4, over: Partial<DiagnosticsHistory> = {}): DiagnosticsHistory {
  return {
    bucketMs: 5_000,
    from: 1_700_000_000_000,
    bucketCount,
    total: {
      cpuPercent: Array.from({ length: bucketCount }, (_, i) => i + 1),
      rssBytes: Array.from({ length: bucketCount }, () => 100_000_000),
      processCount: Array.from({ length: bucketCount }, () => 5)
    },
    objects: [],
    ...over
  }
}

function snapshot(over: Partial<DiagnosticsSnapshot> = {}): DiagnosticsSnapshot {
  return {
    readAt: 1_000,
    sampleIntervalMs: 1_000,
    cores: 16,
    totalMemoryBytes: 34_000_000_000,
    footprint: {
      processCount: 7,
      cpuPercent: 2.05,
      rssBytes: 867_000_000,
      peakRssBytes: 900_000_000,
      starts: 15,
      exits: 8,
      orphanCount: 0
    },
    tree: [
      {
        pid: 100,
        startTimeMs: 1_000,
        ppid: 0,
        depth: 0,
        name: 'argus',
        cpuPercent: 1.5,
        cpuTimeMs: 6_010,
        residentBytes: 546_000_000,
        uptimeMs: 60_000,
        electronType: 'Browser'
      }
    ],
    objects: [],
    sidecar: { status: 'healthy', version: '0.1.0', restartCount: 0, lastError: null },
    ...over
  }
}

beforeEach(() => {
  unsubscribeCalls = 0
  historyCalls = []
  historyResult = emptyHistory()
  terminateMock = vi.fn().mockResolvedValue({ ok: true, route: 'signal', pids: [2] })
  // `confirm`/`alert` come from a module-level vi.mock, so unlike `terminateMock` they are
  // not freshly created each test — reset their call history explicitly, or a later test's
  // `mock.calls[0]` picks up a call an earlier test made.
  vi.mocked(confirm).mockReset().mockResolvedValue(true)
  vi.mocked(alert).mockReset().mockResolvedValue(undefined)
  window.argus = {
    diagnostics: {
      latest: vi.fn().mockResolvedValue(null),
      subscribe: vi.fn().mockResolvedValue(undefined),
      unsubscribe: vi.fn().mockImplementation(() => {
        unsubscribeCalls += 1
        return Promise.resolve()
      }),
      retrySidecar: vi.fn().mockResolvedValue(undefined),
      onSample: vi.fn((cb: (s: DiagnosticsSnapshot) => void) => {
        onSampleCb = cb
        return () => {}
      }),
      history: vi.fn((windowMs: number) => {
        historyCalls.push(windowMs)
        return Promise.resolve(historyResult)
      }),
      terminate: terminateMock
    }
  } as never
})

describe('DiagnosticsSettings', () => {
  it('subscribes on mount and unsubscribes on unmount', () => {
    const { unmount } = render(<DiagnosticsSettings />)
    expect(window.argus.diagnostics.subscribe).toHaveBeenCalled()
    unmount()
    expect(unsubscribeCalls).toBe(1)
  })

  it('renders the footprint from a pushed sample', async () => {
    render(<DiagnosticsSettings />)
    await act(async () => onSampleCb(snapshot()))

    expect(screen.getByTestId('diag-cpu')).toHaveTextContent('2.1%')
    expect(screen.getByTestId('diag-procs')).toHaveTextContent('7')
    expect(screen.getByText(/15 starts · 8 exits/)).toBeInTheDocument()
  })

  it('shows the core count as the CPU denominator', async () => {
    render(<DiagnosticsSettings />)
    await act(async () => onSampleCb(snapshot()))
    expect(screen.getByText(/16 cores/)).toBeInTheDocument()
  })

  it('renders a row per tracked process', async () => {
    render(<DiagnosticsSettings />)
    await act(async () => onSampleCb(snapshot()))
    expect(screen.getByText('argus')).toBeInTheDocument()
    expect(screen.getByText('100')).toBeInTheDocument()
  })

  it('warns but keeps showing stale data when the sidecar goes unavailable mid-session', async () => {
    render(<DiagnosticsSettings />)
    await act(async () =>
      onSampleCb(
        snapshot({
          sidecar: { status: 'unavailable', version: null, restartCount: 5, lastError: 'boom' }
        })
      )
    )
    expect(screen.getByText(/process diagnostics are unavailable/i)).toBeInTheDocument()
    expect(screen.getByText(/\(boom\)/)).toBeInTheDocument()
    expect(screen.getByRole('button', { name: /retry/i })).toBeInTheDocument()
    // A prior sample exists (from the fixture's tree), so the tiles and table
    // still render alongside the banner — this is not the full unavailable panel.
    expect(screen.getByTestId('diag-cpu')).toBeInTheDocument()
    expect(screen.getByText('argus')).toBeInTheDocument()
  })

  it('shows the full unavailable panel — no tiles, no table — when disabled with no prior sample', async () => {
    render(<DiagnosticsSettings />)
    await act(async () =>
      onSampleCb(
        snapshot({
          tree: [],
          sidecar: {
            status: 'disabled',
            version: null,
            restartCount: 0,
            lastError: 'no sidecar binary for this platform'
          }
        })
      )
    )
    expect(screen.getByText(/process diagnostics are unavailable/i)).toBeInTheDocument()
    expect(
      screen.getByText(/no sidecar binary is available for this platform/i)
    ).toBeInTheDocument()
    expect(screen.getByText(/\(no sidecar binary for this platform\)/)).toBeInTheDocument()
    expect(screen.getByRole('button', { name: /retry/i })).toBeInTheDocument()
    expect(screen.queryByTestId('diag-cpu')).not.toBeInTheDocument()
    expect(screen.queryByText('Process tree')).not.toBeInTheDocument()
  })

  it('shows the full unavailable panel when unavailable with no prior sample', async () => {
    render(<DiagnosticsSettings />)
    await act(async () =>
      onSampleCb(
        snapshot({
          tree: [],
          sidecar: {
            status: 'unavailable',
            version: null,
            restartCount: 5,
            lastError: 'sidecar exited with code 1'
          }
        })
      )
    )
    expect(screen.getByText(/process diagnostics are unavailable/i)).toBeInTheDocument()
    expect(
      screen.getByText(/the sidecar crashed repeatedly and stopped retrying automatically/i)
    ).toBeInTheDocument()
    expect(screen.queryByTestId('diag-cpu')).not.toBeInTheDocument()
  })

  it('does not show the unavailable panel when healthy, even with an empty tree', async () => {
    render(<DiagnosticsSettings />)
    await act(async () => onSampleCb(snapshot({ tree: [] })))
    expect(screen.queryByText(/process diagnostics are unavailable/i)).not.toBeInTheDocument()
    expect(screen.getByTestId('diag-cpu')).toBeInTheDocument()
  })

  it('shows a waiting state before the first sample', () => {
    render(<DiagnosticsSettings />)
    expect(screen.getByText(/waiting for the first sample/i)).toBeInTheDocument()
  })

  it('exposes readAt as a liveness hook for the CDP gate', async () => {
    render(<DiagnosticsSettings />)
    await act(async () => onSampleCb(snapshot({ readAt: 4_242 })))
    expect(screen.getByTestId('diag-readat')).toHaveTextContent('4242')
  })

  it('hides the unavailable banner when the sidecar is healthy', async () => {
    render(<DiagnosticsSettings />)
    await act(async () => onSampleCb(snapshot()))

    expect(screen.queryByText(/process diagnostics are unavailable/i)).not.toBeInTheDocument()
    expect(screen.queryByRole('button', { name: /retry/i })).not.toBeInTheDocument()
  })

  it('renders rows in the order the model emits them, without re-sorting', async () => {
    render(<DiagnosticsSettings />)
    await act(async () =>
      onSampleCb(
        snapshot({
          objects: [
            {
              id: '3:1000',
              kind: 'electron-window',
              label: 'Main window',
              inferred: false,
              orphan: false,
              terminable: false,
              busy: false,
              rootPid: 3,
              processCount: 1,
              cpuPercent: 1,
              rssBytes: 1024 * 1024 * 10,
              uptimeMs: 120_000
            },
            {
              id: 'unattributed',
              kind: 'unattributed',
              label: 'Unattributed',
              inferred: false,
              orphan: false,
              terminable: false,
              busy: false,
              rootPid: null,
              processCount: 4,
              cpuPercent: 0.5,
              rssBytes: 1024 * 1024 * 5,
              uptimeMs: 0
            },
            {
              id: '2:1000',
              kind: 'mcp',
              label: 'MCP: github',
              instanceId: 'github',
              inferred: true,
              orphan: false,
              terminable: false,
              busy: false,
              rootPid: 2,
              processCount: 2,
              cpuPercent: 3.2,
              rssBytes: 1024 * 1024 * 40,
              uptimeMs: 65_000
            }
          ]
        })
      )
    )

    const rows = screen.getAllByTestId('diag-object-row')
    expect(rows).toHaveLength(3)
    expect(rows.map((r) => r.getAttribute('data-kind'))).toEqual([
      'electron-window',
      'unattributed',
      'mcp'
    ])
    expect(rows[0]).toHaveTextContent('Main window')
    expect(within(rows[0]).queryByTitle('Inferred from the command line')).toBeNull()
    expect(within(rows[2]).getByTitle('Inferred from the command line')).toBeInTheDocument()
    expect(rows[1].getAttribute('data-procs')).toBe('4')
    // data-inferred is the CDP acceptance gate's only way to tell an authoritative
    // (tier-A) row from an inferred (tier-C) one — pin both values explicitly.
    expect(rows[0].getAttribute('data-inferred')).toBe('false')
    expect(rows[2].getAttribute('data-inferred')).toBe('true')
  })

  it('omits the objects section entirely when there are no objects', async () => {
    render(<DiagnosticsSettings />)
    await act(async () => onSampleCb(snapshot({ objects: [] })))
    expect(screen.queryByText('Argus objects')).toBeNull()
  })

  it('badges an orphaned row and shows its owner', async () => {
    render(<DiagnosticsSettings />)
    await act(async () =>
      onSampleCb(
        snapshot({
          footprint: { ...snapshot().footprint, orphanCount: 1 },
          objects: [
            {
              id: '2:1000',
              kind: 'driver',
              label: 'Codex driver',
              owner: 'CASE-A:7',
              inferred: false,
              orphan: true,
              terminable: false,
              busy: false,
              rootPid: 2,
              processCount: 1,
              cpuPercent: 1,
              rssBytes: 1024 * 1024,
              uptimeMs: 1_000
            }
          ]
        })
      )
    )
    const row = screen.getByTestId('diag-object-row')
    expect(row.getAttribute('data-orphan')).toBe('true')
    expect(row).toHaveTextContent('CASE-A:7')
    expect(
      within(row).getByTitle('The case or session that started this process is gone')
    ).toBeInTheDocument()
    // diag-procs marks only the tile's value div ("7"); the orphan count lives in
    // the sibling sub-text div, so assert on the tile (its parent) as a whole.
    expect(screen.getByTestId('diag-procs').parentElement).toHaveTextContent('1 orphaned')
  })

  it('shows no orphan badge and no orphan count when nothing is orphaned', async () => {
    render(<DiagnosticsSettings />)
    await act(async () => onSampleCb(snapshot()))
    expect(screen.queryByTitle('The case or session that started this process is gone')).toBeNull()
    expect(screen.queryByText(/orphaned/)).toBeNull()
  })
})

describe('DiagnosticsSettings timeline', () => {
  it('fetches the default 15 minute window on mount', async () => {
    render(<DiagnosticsSettings />)
    await act(async () => onSampleCb(snapshot()))
    expect(historyCalls[0]).toBe(15 * 60_000)
  })

  it('refetches with the new window when the selector changes', async () => {
    render(<DiagnosticsSettings />)
    await act(async () => onSampleCb(snapshot()))
    historyCalls = []

    await act(async () => {
      screen.getByRole('button', { name: 'Timeline window · 5m' }).click()
    })
    expect(historyCalls).toContain(5 * 60_000)
  })

  it('renders a CPU and a memory chart from the fetched history', async () => {
    render(<DiagnosticsSettings />)
    await act(async () => onSampleCb(snapshot()))

    expect(screen.getByTestId('diag-timeline-cpu')).toHaveAttribute('data-buckets', '4')
    expect(screen.getByTestId('diag-timeline-cpu')).toHaveAttribute('data-empty', 'false')
    expect(screen.getByTestId('diag-timeline-rss')).toBeInTheDocument()
  })

  it('keeps the page usable when the platform has no diagnostics service', async () => {
    // history() resolves null when `diagnostics` is undefined in main.
    ;(window.argus.diagnostics.history as ReturnType<typeof vi.fn>).mockResolvedValue(null)
    render(<DiagnosticsSettings />)
    await act(async () => onSampleCb(snapshot()))

    expect(screen.queryByTestId('diag-timeline-cpu')).toBeNull()
    expect(screen.getByTestId('diag-cpu')).toBeInTheDocument()
  })

  it('does not refetch history when a pushed sample keeps the same sidecar status', async () => {
    // The history effect depends on `healthy` (a boolean), not on `snap` itself, so it
    // must not re-run on every 1Hz snapshot push — only on a real status transition.
    render(<DiagnosticsSettings />)
    await act(async () => onSampleCb(snapshot()))
    const callsAfterFirstSample = historyCalls.length

    await act(async () => onSampleCb(snapshot({ readAt: 2_000 })))
    expect(historyCalls.length).toBe(callsAfterFirstSample)
  })
})

describe('DiagnosticsSettings object sparklines and ended rows', () => {
  const liveObject = {
    id: '100:1000',
    kind: 'driver' as const,
    label: 'Cursor driver',
    orphan: false,
    inferred: false,
    terminable: false,
    busy: false,
    rootPid: 100,
    processCount: 2,
    cpuPercent: 3,
    rssBytes: 200_000_000,
    uptimeMs: 60_000
  }

  it('renders a sparkline for a live row that has history', async () => {
    ;(window.argus.diagnostics.history as ReturnType<typeof vi.fn>).mockResolvedValue(
      emptyHistory(4, {
        objects: [
          {
            id: '100:1000',
            label: 'Cursor driver',
            kind: 'driver',
            inferred: false,
            live: true,
            cpuPercent: [1, 2, 3, 4],
            rssBytes: [10, 20, 30, 40]
          }
        ]
      })
    )
    render(<DiagnosticsSettings />)
    await act(async () => onSampleCb(snapshot({ objects: [liveObject] })))

    const row = screen.getByTestId('diag-object-row')
    expect(within(row).getByTestId('diag-sparkline')).toHaveAttribute('data-empty', 'false')
  })

  it('leaves the sparkline cell empty for a row with no history yet', async () => {
    render(<DiagnosticsSettings />)
    await act(async () => onSampleCb(snapshot({ objects: [liveObject] })))

    const row = screen.getByTestId('diag-object-row')
    expect(within(row).getByTestId('diag-sparkline')).toHaveAttribute('data-empty', 'true')
  })

  it('shows a dimmed ended row for an object that ran in the window but is gone', async () => {
    ;(window.argus.diagnostics.history as ReturnType<typeof vi.fn>).mockResolvedValue(
      emptyHistory(4, {
        objects: [
          {
            id: '200:2000',
            label: 'Codex driver',
            kind: 'driver',
            inferred: false,
            live: false,
            cpuPercent: [9, 8, null, null],
            rssBytes: [10, 20, null, null]
          }
        ]
      })
    )
    render(<DiagnosticsSettings />)
    await act(async () => onSampleCb(snapshot({ objects: [liveObject] })))

    const ended = screen.getByTestId('diag-object-row-ended')
    expect(ended).toHaveTextContent('Codex driver')
    expect(ended).toHaveTextContent('ended')
    // Numeric cells are em-dashes: an ended row has no current CPU, memory or uptime.
    expect(ended).not.toHaveTextContent('%')
  })

  it('never lists the same object as both live and ended', async () => {
    // `live` is derived from the ring's last recorded bucket while the snapshot's row set
    // comes from the 1Hz push — the two are fetched on different cadences and can
    // disagree for one tick. Both conditions must hold for a row to be "ended".
    ;(window.argus.diagnostics.history as ReturnType<typeof vi.fn>).mockResolvedValue(
      emptyHistory(4, {
        objects: [
          {
            id: '100:1000',
            label: 'Cursor driver',
            kind: 'driver',
            inferred: false,
            live: false,
            cpuPercent: [1, 2, 3, 4],
            rssBytes: [10, 20, 30, 40]
          }
        ]
      })
    )
    render(<DiagnosticsSettings />)
    await act(async () => onSampleCb(snapshot({ objects: [liveObject] })))

    expect(screen.queryByTestId('diag-object-row-ended')).toBeNull()
    expect(screen.getAllByTestId('diag-object-row')).toHaveLength(1)
  })

  it('caps ended rows and says how many were left out', async () => {
    const many = Array.from({ length: 12 }, (_, i) => ({
      id: `${i}:1`,
      label: `Gone ${i}`,
      kind: 'driver' as const,
      inferred: false,
      live: false,
      cpuPercent: [i + 1, null, null, null],
      rssBytes: [10, null, null, null]
    }))
    ;(window.argus.diagnostics.history as ReturnType<typeof vi.fn>).mockResolvedValue(
      emptyHistory(4, { objects: many })
    )
    render(<DiagnosticsSettings />)
    await act(async () => onSampleCb(snapshot({ objects: [liveObject] })))

    expect(screen.getAllByTestId('diag-object-row-ended')).toHaveLength(8)
    expect(screen.getByText(/4 more/)).toBeInTheDocument()
  })

  it('scopes the reconciliation claim to the live rows', async () => {
    render(<DiagnosticsSettings />)
    await act(async () => onSampleCb(snapshot({ objects: [liveObject] })))
    // The unqualified "These rows account for the footprint" would be false the moment an
    // ended row appears, because ended rows sit outside 2a's partition.
    expect(screen.getByText(/live rows account for the footprint/i)).toBeInTheDocument()
  })

  it('never renders the synthetic unattributed id as an ended row', async () => {
    // splitRows excludes 'unattributed' explicitly — it is synthetic and exists whenever
    // a snapshot does, so it can never legitimately have "exited" — but nothing pinned
    // that exclusion until now.
    ;(window.argus.diagnostics.history as ReturnType<typeof vi.fn>).mockResolvedValue(
      emptyHistory(4, {
        objects: [
          {
            id: 'unattributed',
            label: 'Unattributed',
            kind: 'unattributed',
            inferred: false,
            live: false,
            cpuPercent: [1, 2, null, null],
            rssBytes: [10, 20, null, null]
          }
        ]
      })
    )
    render(<DiagnosticsSettings />)
    await act(async () => onSampleCb(snapshot({ objects: [liveObject] })))

    expect(screen.queryByTestId('diag-object-row-ended')).toBeNull()
  })
})

describe('stop', () => {
  it('shows a Stop button only on terminable rows', async () => {
    render(<DiagnosticsSettings />)
    await act(async () =>
      onSampleCb(
        snapshot({
          objects: [
            objectRow(),
            objectRow({
              id: '1:1000',
              kind: 'electron-internal',
              label: 'Argus main process',
              terminable: false
            })
          ]
        })
      )
    )
    expect(screen.getByRole('button', { name: 'Stop MCP: demo' })).toBeInTheDocument()
    expect(
      screen.queryByRole('button', { name: 'Stop Argus main process' })
    ).not.toBeInTheDocument()
  })

  it('warns that the turn will fail when the row is busy', async () => {
    render(<DiagnosticsSettings />)
    await act(async () =>
      onSampleCb(snapshot({ objects: [objectRow({ busy: true, label: 'Cursor' })] }))
    )
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: 'Stop Cursor' }))
    })
    expect(vi.mocked(confirm).mock.calls[0][0].message).toContain('working on a turn')
  })

  it('says the owner is already gone for an orphan', async () => {
    render(<DiagnosticsSettings />)
    await act(async () => onSampleCb(snapshot({ objects: [objectRow({ orphan: true })] })))
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: 'Stop MCP: demo' }))
    })
    expect(vi.mocked(confirm).mock.calls[0][0].message).toContain('already gone')
  })

  it('does not call terminate when the confirm is declined', async () => {
    vi.mocked(confirm).mockResolvedValueOnce(false)
    render(<DiagnosticsSettings />)
    await act(async () => onSampleCb(snapshot({ objects: [objectRow()] })))
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: 'Stop MCP: demo' }))
    })
    expect(terminateMock).not.toHaveBeenCalled()
  })

  it('shows the row as stopping until it leaves the snapshot', async () => {
    render(<DiagnosticsSettings />)
    await act(async () => onSampleCb(snapshot({ objects: [objectRow()] })))
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: 'Stop MCP: demo' }))
    })
    expect(screen.getByRole('button', { name: 'Stop MCP: demo' })).toBeDisabled()
    expect(screen.getByText('Stopping…')).toBeInTheDocument()

    // The sample stream, not the terminate() return value, is what clears it.
    await act(async () => onSampleCb(snapshot({ objects: [] })))
    expect(screen.queryByText('Stopping…')).not.toBeInTheDocument()

    // The row vanishing from the DOM when it drops out of the snapshot would make the
    // assertion above pass even if the pending set were never actually cleared — the
    // ObjectRow simply isn't rendered while its id is absent from snap.objects. Bring the
    // same id back to prove the internal pending state itself was cleared, not just that
    // the row was briefly gone: if `pending` still held '2:1000', this row would render
    // disabled and "Stopping…" again.
    await act(async () => onSampleCb(snapshot({ objects: [objectRow()] })))
    expect(screen.getByRole('button', { name: 'Stop MCP: demo' })).not.toBeDisabled()
    expect(screen.queryByText('Stopping…')).not.toBeInTheDocument()
  })

  it('re-enables the button after the pending timeout even when the row never leaves the snapshot', async () => {
    // Pins the finding: terminate() can return `ok: true` and then the sample stream
    // never drops the row again (owner teardown that doesn't reap the child; or the
    // sidecar dying right after the press, so publishHealth keeps republishing the same
    // stale objects). Without a bounded escape, the button would stay "Stopping…" and
    // disabled forever, recoverable only by unmounting the page.
    vi.useFakeTimers()
    try {
      render(<DiagnosticsSettings />)
      await act(async () => onSampleCb(snapshot({ objects: [objectRow()] })))
      await act(async () => {
        fireEvent.click(screen.getByRole('button', { name: 'Stop MCP: demo' }))
      })
      expect(screen.getByRole('button', { name: 'Stop MCP: demo' })).toBeDisabled()
      expect(screen.getByText('Stopping…')).toBeInTheDocument()

      // The stream keeps re-affirming the SAME row is still present — it never proves the
      // process died, so the stream-based clearing path never fires.
      await act(async () => onSampleCb(snapshot({ objects: [objectRow()] })))
      expect(screen.getByRole('button', { name: 'Stop MCP: demo' })).toBeDisabled()

      // Advancing past the timeout inside act() flushes the resulting setPending update.
      await act(async () => {
        vi.advanceTimersByTime(STOP_PENDING_TIMEOUT_MS)
      })

      expect(screen.getByRole('button', { name: 'Stop MCP: demo' })).not.toBeDisabled()
      expect(screen.queryByText('Stopping…')).not.toBeInTheDocument()
      expect(screen.getByRole('button', { name: 'Stop MCP: demo' })).toHaveTextContent('Stop')
    } finally {
      vi.useRealTimers()
    }
  })

  it('surfaces a failure and clears the pending state', async () => {
    terminateMock.mockResolvedValueOnce({ ok: false, reason: 'failed', message: 'boom' })
    render(<DiagnosticsSettings />)
    await act(async () => onSampleCb(snapshot({ objects: [objectRow()] })))
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: 'Stop MCP: demo' }))
    })
    expect(vi.mocked(alert).mock.calls[0][0]).toMatchObject({ message: 'boom' })
    expect(screen.getByRole('button', { name: 'Stop MCP: demo' })).not.toBeDisabled()
  })

  it("clears a pressed row's escape-hatch timer, not just its pending flag, when the stream proves it is gone", async () => {
    // Pins the stream-clears-timers loop specifically (as opposed to the stream-clears-
    // pending behaviour already covered by "shows the row as stopping..."). The escape
    // hatch's job is done the moment the stream proves the row is actually gone — if its
    // timer isn't ALSO cleared then (not just removed from `pending`), it lingers as a
    // stray timer that could later fire during a SUBSEQUENT press for the same id.
    // `vi.getTimerCount()` is used because the button/pending-state-only assertions on
    // their own can't distinguish this: a second press always arms its own fresh timer
    // regardless of whether the first press's stray timer was cleaned up, so only
    // directly counting the pending native timers proves the leak is gone.
    vi.useFakeTimers()
    try {
      render(<DiagnosticsSettings />)
      await act(async () => onSampleCb(snapshot({ objects: [objectRow()] })))
      const timersBeforePress = vi.getTimerCount()

      // t=0: press 1.
      await act(async () => {
        fireEvent.click(screen.getByRole('button', { name: 'Stop MCP: demo' }))
      })
      expect(vi.getTimerCount()).toBe(timersBeforePress + 1)

      // t=2s: the stream proves the row is gone — this is the normal, sole proof of
      // death, arriving well before press 1's own escape-hatch deadline (t=10s).
      await act(async () => {
        vi.advanceTimersByTime(2_000)
      })
      await act(async () => onSampleCb(snapshot({ objects: [] })))
      expect(screen.queryByText('Stopping…')).not.toBeInTheDocument()
      // The escape-hatch timer must be gone too, back to the pre-press count — not just
      // `pending`. This is the one assertion the "still disabled" checks below can't
      // make on their own: a second press always arms its own fresh timer regardless of
      // whether the first press's stray timer was cleaned up, so only directly counting
      // the pending native timers proves the leak itself is gone.
      expect(vi.getTimerCount()).toBe(timersBeforePress)

      // Still t=2s: row comes back; press again (press 2, timer deadline t=12s).
      await act(async () => onSampleCb(snapshot({ objects: [objectRow()] })))
      await act(async () => {
        fireEvent.click(screen.getByRole('button', { name: 'Stop MCP: demo' }))
      })
      expect(screen.getByRole('button', { name: 'Stop MCP: demo' })).toBeDisabled()

      // t=10s: roughly the timeout window elapsed since the FIRST press (press 1's own
      // deadline, had its timer not been cleared at t=2s) — but only 8s since press 2,
      // which is still short of ITS deadline (t=12s). The row must still read
      // "Stopping…": press 2's own state, undisturbed by press 1's timer.
      await act(async () => {
        vi.advanceTimersByTime(8_000)
      })
      expect(screen.getByRole('button', { name: 'Stop MCP: demo' })).toBeDisabled()
      expect(screen.getByText('Stopping…')).toBeInTheDocument()
    } finally {
      vi.useRealTimers()
    }
  })

  it("ignores a stale press's late failure so it cannot clear a later press's pending state", async () => {
    // Pins Finding 1: the main process has no in-flight guard on terminate(), so the
    // disabled-while-pending button is the only thing preventing two overlapping kill
    // sequences for one row. Sequence from the review finding:
    //   t=0   press 1: pending={X}, timer T1 armed, terminate(X) in flight (slow/hung).
    //   t=10s T1 fires: pending={}, button re-enabled (the escape hatch, working as
    //         intended — terminate() for press 1 STILL hasn't resolved).
    //   t=11s press 2: pending={X}, timer T2 armed, a second terminate(X) in flight.
    //   t=15s press 1's call finally resolves ok:false. Without a token guard this would
    //         clear T2 and press 2's pending entry, re-enabling the button while press
    //         2's kill is still running, and alert about press 1 as though it were press
    //         2's failure.
    vi.useFakeTimers()
    try {
      render(<DiagnosticsSettings />)
      await act(async () => onSampleCb(snapshot({ objects: [objectRow()] })))

      let resolvePress1: (v: { ok: false; reason: 'failed'; message: string }) => void = () => {}
      const press1Result = new Promise<{ ok: false; reason: 'failed'; message: string }>(
        (resolve) => {
          resolvePress1 = resolve
        }
      )
      terminateMock.mockImplementationOnce(() => press1Result)

      // t=0: press 1.
      await act(async () => {
        fireEvent.click(screen.getByRole('button', { name: 'Stop MCP: demo' }))
      })
      expect(screen.getByRole('button', { name: 'Stop MCP: demo' })).toBeDisabled()

      // t=10s: the escape hatch fires. Press 1's terminate() call is still in flight.
      await act(async () => {
        vi.advanceTimersByTime(STOP_PENDING_TIMEOUT_MS)
      })
      expect(screen.getByRole('button', { name: 'Stop MCP: demo' })).not.toBeDisabled()

      // t=11s: press 2. terminateMock falls back to its default (resolves ok:true), so
      // this press's own terminate() call settles harmlessly and leaves it pending on
      // the stream, same as any other successful stop.
      await act(async () => {
        vi.advanceTimersByTime(1_000)
      })
      await act(async () => {
        fireEvent.click(screen.getByRole('button', { name: 'Stop MCP: demo' }))
      })
      expect(screen.getByRole('button', { name: 'Stop MCP: demo' })).toBeDisabled()

      // t=15s: press 1's slow call finally resolves, with a real failure.
      await act(async () => {
        resolvePress1({ ok: false, reason: 'failed', message: 'press 1 boom' })
        await press1Result
        await Promise.resolve()
        await Promise.resolve()
      })

      // Press 2's pending/timer state must be untouched: still "Stopping…", still
      // disabled.
      expect(screen.getByRole('button', { name: 'Stop MCP: demo' })).toBeDisabled()
      expect(screen.getByText('Stopping…')).toBeInTheDocument()
      // The failure is still real and still worth surfacing — only the state mutation
      // was stale, not the alert.
      expect(vi.mocked(alert)).toHaveBeenCalledTimes(1)
      expect(vi.mocked(alert).mock.calls[0][0]).toMatchObject({ message: 'press 1 boom' })
    } finally {
      vi.useRealTimers()
    }
  })

  it('an ended row offers no Stop button — there is nothing left to stop', async () => {
    historyResult = emptyHistory(4, {
      objects: [
        {
          id: '9:1000',
          label: 'MCP: dead',
          kind: 'mcp',
          inferred: false,
          live: false,
          cpuPercent: [1, 2, 3, 4],
          rssBytes: [10, 10, 10, 10]
        }
      ]
    })
    render(<DiagnosticsSettings />)
    await act(async () => onSampleCb(snapshot({ objects: [objectRow()] })))

    expect(screen.getByTestId('diag-object-row-ended')).toBeInTheDocument()
    expect(screen.queryByRole('button', { name: 'Stop MCP: dead' })).not.toBeInTheDocument()
  })
})
