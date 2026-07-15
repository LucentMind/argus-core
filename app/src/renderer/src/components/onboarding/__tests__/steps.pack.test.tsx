// @vitest-environment jsdom
import { render, screen, waitFor } from '@testing-library/react'
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
})
