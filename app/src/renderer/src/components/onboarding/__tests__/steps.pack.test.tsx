// @vitest-environment jsdom
import { render, screen, waitFor, fireEvent } from '@testing-library/react'
import { describe, it, expect, vi } from 'vitest'
import { PackStep } from '../steps'

describe('PackStep', () => {
  it('opens the gate when a pack is present', async () => {
    window.argus = {
      packs: {
        list: vi.fn(async () => ({
          packs: [
            {
              id: 'sample-text-viewer',
              displayName: 'Sample Text Viewer',
              installedVersion: null,
              loadedVersion: '1.0.0',
              platform: null,
              pendingRelaunch: false,
              binaries: []
            }
          ],
          error: null
        }))
      }
    } as never
    const setGate = vi.fn()
    render(<PackStep setGate={setGate} />)
    await waitFor(() => expect(screen.getByText(/Sample Text Viewer/)).toBeTruthy())
    expect(setGate).toHaveBeenLastCalledWith(true)
  })

  it('keeps the gate closed when no packs are present', async () => {
    window.argus = { packs: { list: vi.fn(async () => ({ packs: [], error: null })) } } as never
    const setGate = vi.fn()
    render(<PackStep setGate={setGate} />)
    await waitFor(() => expect(screen.getByText(/no packs/i)).toBeTruthy())
    expect(setGate).toHaveBeenLastCalledWith(false)
  })

  it('offers an "Install a pack" action that opens Packs settings', async () => {
    window.argus = { packs: { list: vi.fn(async () => ({ packs: [], error: null })) } } as never
    const onOpenSettings = vi.fn()
    render(<PackStep setGate={vi.fn()} onOpenSettings={onOpenSettings} />)
    const btn = await screen.findByRole('button', { name: /install a pack/i })
    fireEvent.click(btn)
    expect(onOpenSettings).toHaveBeenCalledTimes(1)
  })

  it('omits the install action when no onOpenSettings is provided', async () => {
    window.argus = { packs: { list: vi.fn(async () => ({ packs: [], error: null })) } } as never
    render(<PackStep setGate={vi.fn()} />)
    await waitFor(() => expect(screen.getByText(/no packs/i)).toBeTruthy())
    expect(screen.queryByRole('button', { name: /install a pack/i })).toBeNull()
  })
})
