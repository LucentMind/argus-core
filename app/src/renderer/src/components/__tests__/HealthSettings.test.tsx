// @vitest-environment jsdom
import { describe, it, expect, beforeEach, vi } from 'vitest'
import { render, screen, fireEvent, act } from '@testing-library/react'
import { HealthSettings } from '../settings/HealthSettings'
import type { HealthCheckResult, HealthRow } from '../../../../shared/health'

const ROWS: HealthRow[] = [
  { id: 'bin:tool-x', label: 'Tool X binary', category: 'tools' },
  { id: 'agent', label: 'Agent auth', category: 'general' },
  { id: 'connector:rovo', label: 'Connector: rovo', category: 'connectors' }
]

let onResultCb: ((r: HealthCheckResult) => void) | null = null

beforeEach(() => {
  onResultCb = null
  window.argus = {
    health: {
      list: vi.fn().mockResolvedValue(ROWS),
      run: vi.fn().mockResolvedValue(undefined),
      onResult: vi.fn((cb: (r: HealthCheckResult) => void) => {
        onResultCb = cb
        return () => {}
      })
    }
  } as never
})

describe('HealthSettings', () => {
  it('lists rows, auto-runs on mount, streams results into chips', async () => {
    render(<HealthSettings />)
    expect(await screen.findByText('Tool X binary')).toBeTruthy()
    expect(window.argus.health.run).toHaveBeenCalledWith()
    expect(screen.getAllByText('checking…')).toHaveLength(3)
    act(() =>
      onResultCb!({
        id: 'bin:tool-x',
        label: 'Tool X binary',
        ok: true,
        detail: 'C:\\p.exe · 0.3.0'
      })
    )
    expect(screen.getByLabelText('ok')).toBeTruthy()
    expect(screen.getByText(/0\.3\.0/)).toBeTruthy()
    act(() =>
      onResultCb!({
        id: 'agent',
        label: 'Agent auth',
        ok: false,
        detail: 'not logged in',
        fixHint: 'Run claude login.'
      })
    )
    expect(screen.getByLabelText('fail')).toBeTruthy()
    expect(screen.getByText('Run claude login.')).toBeTruthy()
  })

  it('Run all re-runs everything; per-row re-run passes the id', async () => {
    render(<HealthSettings />)
    await screen.findByText('Agent auth')
    fireEvent.click(screen.getByRole('button', { name: /run all checks/i }))
    expect(window.argus.health.run).toHaveBeenLastCalledWith()
    fireEvent.click(screen.getByRole('button', { name: /re-run · agent/i }))
    expect(window.argus.health.run).toHaveBeenLastCalledWith(['agent'])
  })

  it('a stale result from a superseded run does not overwrite a fresh running state', async () => {
    render(<HealthSettings />)
    await screen.findByText('Tool X binary')
    // the mount run's result lands normally
    act(() => onResultCb!({ id: 'bin:tool-x', label: 'Tool X binary', ok: true, detail: 'v1' }))
    expect(screen.getByText('v1')).toBeTruthy()
    // two per-row re-runs: the first is superseded by the second
    fireEvent.click(screen.getByRole('button', { name: /re-run · bin:tool-x/i }))
    fireEvent.click(screen.getByRole('button', { name: /re-run · bin:tool-x/i }))
    act(() => onResultCb!({ id: 'bin:tool-x', label: 'Tool X binary', ok: false, detail: 'stale' }))
    expect(screen.queryByText('stale')).toBeNull() // superseded run: keep 'checking…'
    act(() => onResultCb!({ id: 'bin:tool-x', label: 'Tool X binary', ok: true, detail: 'fresh' }))
    expect(screen.getByText('fresh')).toBeTruthy()
  })

  it('unmounting before list() resolves does not start the run', async () => {
    let resolveList!: (rs: HealthRow[]) => void
    window.argus.health.list = vi.fn(
      () =>
        new Promise<HealthRow[]>((res) => {
          resolveList = res
        })
    ) as typeof window.argus.health.list
    const { unmount } = render(<HealthSettings />)
    unmount()
    await act(async () => resolveList(ROWS))
    expect(window.argus.health.run).not.toHaveBeenCalled()
  })

  it('Run all is disabled while a run is in flight, from mount and from click', async () => {
    let resolveRun!: () => void
    window.argus.health.run = vi.fn(
      () =>
        new Promise<void>((res) => {
          resolveRun = res
        })
    ) as typeof window.argus.health.run
    render(<HealthSettings />)
    await screen.findByText('Agent auth')
    const btn = screen.getByRole('button', { name: /run all checks/i }) as HTMLButtonElement
    expect(btn.disabled).toBe(true) // mount auto-run still in flight
    await act(async () => resolveRun())
    expect(btn.disabled).toBe(false)
    fireEvent.click(btn)
    expect(btn.disabled).toBe(true)
    await act(async () => resolveRun())
    expect(btn.disabled).toBe(false)
  })
})
