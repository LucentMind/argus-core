// @vitest-environment jsdom
import { describe, it, expect, beforeEach, vi } from 'vitest'
import { render, screen, fireEvent, act } from '@testing-library/react'
import { HealthSettings } from '../settings/HealthSettings'
import type { HealthCheckResult, HealthRow } from '../../../../shared/health'

const ROWS: HealthRow[] = [
  { id: 'parse', label: 'sample-parse binary' },
  { id: 'agent', label: 'Agent auth' },
  { id: 'connector:rovo', label: 'Connector: rovo' }
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
    expect(await screen.findByText('sample-parse binary')).toBeTruthy()
    expect(window.argus.health.run).toHaveBeenCalledWith()
    expect(screen.getAllByText('checking…')).toHaveLength(3)
    act(() =>
      onResultCb!({
        id: 'parse',
        label: 'sample-parse binary',
        ok: true,
        detail: 'C:\\p.exe · 0.3.0'
      })
    )
    expect(screen.getByText('ok')).toBeTruthy()
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
    expect(screen.getByText('fail')).toBeTruthy()
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
})
