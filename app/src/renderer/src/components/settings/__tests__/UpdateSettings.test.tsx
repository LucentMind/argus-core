// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import '@testing-library/jest-dom/vitest'
import { UpdateSettings } from '../UpdateSettings'
import { updateStore } from '../../../lib/updateStore'
import type { CoreUpdatePayload } from '../../../../../shared/updates'

const idle: CoreUpdatePayload = { currentVersion: '1.0.8', status: { phase: 'idle' } }

function stubApi(
  over: Partial<Record<string, unknown>> = {},
  devToolsUnlock: () => Promise<{ devTools: boolean }> = vi.fn(async () => ({ devTools: false }))
): void {
  ;(window as unknown as { argus: unknown }).argus = {
    update: {
      status: vi.fn(async () => idle),
      check: vi.fn(async () => idle),
      download: vi.fn(async () => idle),
      restart: vi.fn(async () => idle),
      onChanged: vi.fn(() => () => {}),
      ...over
    },
    devTools: { unlock: devToolsUnlock }
  }
}

beforeEach(() => {
  updateStore.clearForTests()
  stubApi()
})

describe('UpdateSettings', () => {
  it('shows the running version once the store has loaded', async () => {
    render(<UpdateSettings />)
    expect(await screen.findByText('1.0.8')).toBeInTheDocument()
  })

  it('offers a download only when an update is available', async () => {
    stubApi({
      status: vi.fn(async () => ({
        currentVersion: '1.0.8',
        status: { phase: 'available', version: '1.1.0' }
      }))
    })
    render(<UpdateSettings />)
    expect(await screen.findByRole('button', { name: /download 1\.1\.0/i })).toBeInTheDocument()
  })

  it('checking on demand calls through and renders the result', async () => {
    const check = vi.fn(async () => ({
      currentVersion: '1.0.8',
      status: { phase: 'available' as const, version: '1.1.0' }
    }))
    stubApi({ check })
    render(<UpdateSettings />)
    await userEvent.click(await screen.findByRole('button', { name: /check for updates/i }))
    expect(check).toHaveBeenCalledOnce()
    expect(await screen.findByRole('button', { name: /download 1\.1\.0/i })).toBeInTheDocument()
  })

  it('offers a restart once bytes are staged', async () => {
    const restart = vi.fn(async () => idle)
    stubApi({
      status: vi.fn(async () => ({
        currentVersion: '1.0.8',
        status: { phase: 'ready', version: '1.1.0' }
      })),
      restart
    })
    render(<UpdateSettings />)
    await userEvent.click(await screen.findByRole('button', { name: /restart/i }))
    expect(restart).toHaveBeenCalledOnce()
  })

  it('renders an unpackaged build as an explanation, not an error', async () => {
    stubApi({
      status: vi.fn(async () => ({
        currentVersion: '1.0.8',
        status: { phase: 'unsupported', reason: 'Updates are only available in a packaged build' }
      }))
    })
    render(<UpdateSettings />)
    expect(await screen.findByText(/only available in a packaged build/i)).toBeInTheDocument()
    expect(screen.queryByRole('button', { name: /check for updates/i })).not.toBeInTheDocument()
  })

  it('shows a failed manual check', async () => {
    stubApi({
      status: vi.fn(async () => ({
        currentVersion: '1.0.8',
        status: { phase: 'error', message: 'offline', at: 1 }
      }))
    })
    render(<UpdateSettings />)
    expect(await screen.findByText(/offline/)).toBeInTheDocument()
  })

  it('does not say "Check failed" for an error that came from a failed download', async () => {
    // Regression: the error phase is also produced by download() (see coreUpdater.ts), so its
    // wording must stay neutral about which step failed.
    stubApi({
      status: vi.fn(async () => ({
        currentVersion: '1.0.8',
        status: { phase: 'error', message: 'disk full', at: 1 }
      }))
    })
    render(<UpdateSettings />)
    expect(await screen.findByText(/disk full/)).toBeInTheDocument()
    expect(screen.queryByText(/check failed/i)).not.toBeInTheDocument()
  })

  it('shows a checking description, not a stale "up to date", while a check is in flight', async () => {
    stubApi({
      status: vi.fn(async () => ({
        currentVersion: '1.0.8',
        status: { phase: 'checking' }
      }))
    })
    render(<UpdateSettings />)
    expect(await screen.findByText(/checking for updates/i)).toBeInTheDocument()
    expect(screen.queryByText(/up to date/i)).not.toBeInTheDocument()
  })

  it('clicking the version 6 times unlocks dev tools and asks for a restart', async () => {
    const unlock = vi.fn(async () => ({ devTools: false }))
    stubApi({}, unlock)
    render(<UpdateSettings />)
    const version = await screen.findByText('1.0.8')
    for (let i = 0; i < 6; i++) await userEvent.click(version)
    expect(unlock).toHaveBeenCalledOnce()
    expect(await screen.findByText(/restart argus/i)).toBeInTheDocument()
  })

  it('does not unlock on fewer than 6 clicks', async () => {
    const unlock = vi.fn(async () => ({ devTools: false }))
    stubApi({}, unlock)
    render(<UpdateSettings />)
    const version = await screen.findByText('1.0.8')
    for (let i = 0; i < 5; i++) await userEvent.click(version)
    expect(unlock).not.toHaveBeenCalled()
  })

  it('reports already-enabled instead of asking for a restart when the gate is already on', async () => {
    const unlock = vi.fn(async () => ({ devTools: true }))
    stubApi({}, unlock)
    render(<UpdateSettings />)
    const version = await screen.findByText('1.0.8')
    for (let i = 0; i < 6; i++) await userEvent.click(version)
    expect(await screen.findByText(/already enabled/i)).toBeInTheDocument()
  })
})
