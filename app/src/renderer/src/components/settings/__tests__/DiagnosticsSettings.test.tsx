// @vitest-environment jsdom
import '@testing-library/jest-dom/vitest'
import { describe, it, expect, beforeEach, vi } from 'vitest'
import { render, screen, act } from '@testing-library/react'
import DiagnosticsSettings from '../DiagnosticsSettings'
import type { DiagnosticsSnapshot } from '../../../../../shared/diagnostics'

let onSampleCb: (s: DiagnosticsSnapshot) => void = () => {}
let unsubscribeCalls = 0

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
      exits: 8
    },
    tree: [
      {
        pid: 100,
        startTimeMs: 1_000,
        ppid: 0,
        depth: 0,
        name: 'argus',
        command: 'argus',
        cpuPercent: 1.5,
        cpuTimeMs: 6_010,
        residentBytes: 546_000_000,
        uptimeMs: 60_000,
        electronType: 'Browser'
      }
    ],
    sidecar: { status: 'healthy', version: '0.1.0', restartCount: 0, lastError: null },
    ...over
  }
}

beforeEach(() => {
  unsubscribeCalls = 0
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
      })
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

  it('warns when the sidecar is unavailable', async () => {
    render(<DiagnosticsSettings />)
    await act(async () =>
      onSampleCb(
        snapshot({
          sidecar: { status: 'unavailable', version: null, restartCount: 5, lastError: 'boom' }
        })
      )
    )
    expect(screen.getByText(/child-process attribution is unavailable/i)).toBeInTheDocument()
    expect(screen.getByRole('button', { name: /retry/i })).toBeInTheDocument()
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

  it('hides the degraded banner when the sidecar is healthy', async () => {
    render(<DiagnosticsSettings />)
    await act(async () => onSampleCb(snapshot()))

    expect(screen.queryByText(/child-process attribution is unavailable/i)).not.toBeInTheDocument()
    expect(screen.queryByRole('button', { name: /retry/i })).not.toBeInTheDocument()
  })
})
