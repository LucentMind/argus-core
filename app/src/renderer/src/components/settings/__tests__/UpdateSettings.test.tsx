// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import '@testing-library/jest-dom/vitest'
import { UpdateSettings } from '../UpdateSettings'
import { updateStore } from '../../../lib/updateStore'
import type { CoreUpdatePayload } from '../../../../../shared/updates'

const idle: CoreUpdatePayload = { currentVersion: '1.0.8', status: { phase: 'idle' } }

function stubApi(over: Partial<Record<string, unknown>> = {}): void {
  ;(window as unknown as { argus: unknown }).argus = {
    update: {
      status: vi.fn(async () => idle),
      check: vi.fn(async () => idle),
      download: vi.fn(async () => idle),
      restart: vi.fn(async () => {}),
      onChanged: vi.fn(() => () => {}),
      ...over
    }
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
    const restart = vi.fn(async () => {})
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
})
