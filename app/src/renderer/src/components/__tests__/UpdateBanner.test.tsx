// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { act, render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import '@testing-library/jest-dom/vitest'
import { UpdateBanner } from '../UpdateBanner'
import { updateStore } from '../../lib/updateStore'
import type { CoreUpdatePayload, UpdateStatus } from '../../../../shared/updates'

const idle: CoreUpdatePayload = { currentVersion: '1.0.8', status: { phase: 'idle' } }

let onChangedCb: ((p: CoreUpdatePayload) => void) | null = null

function stubApi(initial: CoreUpdatePayload = idle): void {
  onChangedCb = null
  ;(window as unknown as { argus: unknown }).argus = {
    update: {
      status: vi.fn(async () => initial),
      check: vi.fn(async () => initial),
      download: vi.fn(async () => initial),
      restart: vi.fn(async () => initial),
      onChanged: vi.fn((cb: (p: CoreUpdatePayload) => void) => {
        onChangedCb = cb
        return () => {
          onChangedCb = null
        }
      })
    }
  }
}

/** Push a status update through the same `onChanged` path main uses in production. */
function emitStatus(status: UpdateStatus, currentVersion = '1.0.8'): void {
  if (!onChangedCb) throw new Error('onChanged callback was never captured')
  act(() => onChangedCb!({ currentVersion, status }))
}

beforeEach(() => {
  updateStore.clearForTests()
  stubApi()
})

describe('UpdateBanner', () => {
  it('renders with a Download action when an update is available', async () => {
    stubApi({ currentVersion: '1.0.8', status: { phase: 'available', version: '1.1.0' } })
    render(<UpdateBanner />)
    expect(await screen.findByText(/argus 1\.1\.0 is available/i)).toBeInTheDocument()
    expect(screen.getByRole('button', { name: /download/i })).toBeInTheDocument()
  })

  it('hides once the available banner is dismissed', async () => {
    stubApi({ currentVersion: '1.0.8', status: { phase: 'available', version: '1.1.0' } })
    render(<UpdateBanner />)
    await screen.findByText(/argus 1\.1\.0 is available/i)
    await userEvent.click(screen.getByRole('button', { name: /dismiss update notice/i }))
    expect(screen.queryByText(/argus 1\.1\.0 is available/i)).not.toBeInTheDocument()
  })

  it('re-shows for the same version once it transitions from available to ready', async () => {
    // This is the bug: dismissing "an update exists" must not also dismiss the far more
    // actionable "it is downloaded and waiting for you" notice for the same version.
    stubApi({ currentVersion: '1.0.8', status: { phase: 'available', version: '1.1.0' } })
    render(<UpdateBanner />)
    await screen.findByText(/argus 1\.1\.0 is available/i)
    await userEvent.click(screen.getByRole('button', { name: /dismiss update notice/i }))
    expect(screen.queryByText(/argus 1\.1\.0 is available/i)).not.toBeInTheDocument()

    emitStatus({ phase: 'ready', version: '1.1.0' })

    expect(await screen.findByText(/argus 1\.1\.0 is ready to install/i)).toBeInTheDocument()
    expect(screen.getByRole('button', { name: /restart now/i })).toBeInTheDocument()
  })

  it('hides once the ready banner is dismissed', async () => {
    stubApi({ currentVersion: '1.0.8', status: { phase: 'ready', version: '1.1.0' } })
    render(<UpdateBanner />)
    await screen.findByText(/argus 1\.1\.0 is ready to install/i)
    await userEvent.click(screen.getByRole('button', { name: /dismiss update notice/i }))
    expect(screen.queryByText(/argus 1\.1\.0 is ready to install/i)).not.toBeInTheDocument()
  })

  it('re-shows after a dismissal once a different version shows up', async () => {
    stubApi({ currentVersion: '1.0.8', status: { phase: 'available', version: '1.1.0' } })
    render(<UpdateBanner />)
    await screen.findByText(/argus 1\.1\.0 is available/i)
    await userEvent.click(screen.getByRole('button', { name: /dismiss update notice/i }))
    expect(screen.queryByText(/argus 1\.1\.0 is available/i)).not.toBeInTheDocument()

    emitStatus({ phase: 'available', version: '1.2.0' })

    expect(await screen.findByText(/argus 1\.2\.0 is available/i)).toBeInTheDocument()
  })

  it('renders nothing for phases other than available/ready', async () => {
    render(<UpdateBanner />)
    await act(async () => {})
    expect(screen.queryByRole('button')).not.toBeInTheDocument()

    emitStatus({ phase: 'checking' })
    expect(screen.queryByRole('button')).not.toBeInTheDocument()
  })
})
