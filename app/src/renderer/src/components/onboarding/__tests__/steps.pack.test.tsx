// @vitest-environment jsdom
import { render, screen, waitFor, fireEvent } from '@testing-library/react'
import { describe, it, expect, vi } from 'vitest'
import { PackStep } from '../steps'

const PACK = {
  id: 'sample-text-viewer',
  displayName: 'Sample Text Viewer',
  installedVersion: null,
  loadedVersion: '1.0.0',
  platform: null,
  pendingRelaunch: false,
  binaries: []
}

describe('PackStep (final, non-gating)', () => {
  it('lists installed packs', async () => {
    window.argus = {
      packs: { list: vi.fn(async () => ({ packs: [PACK], error: null })) }
    } as never
    render(<PackStep />)
    await waitFor(() => expect(screen.getByText(/Sample Text Viewer/)).toBeTruthy())
  })

  it('renders fine with no packs (never a dead end — the step is optional)', async () => {
    window.argus = { packs: { list: vi.fn(async () => ({ packs: [], error: null })) } } as never
    render(<PackStep />)
    await waitFor(() => expect(window.argus.packs.list).toHaveBeenCalled())
    // no "installed packs" heading, no gating, no error copy
    expect(screen.queryByText(/installed packs/i)).toBeNull()
  })

  it('offers an "Install a pack" action that opens Packs settings', async () => {
    window.argus = { packs: { list: vi.fn(async () => ({ packs: [], error: null })) } } as never
    const onOpenSettings = vi.fn()
    render(<PackStep onOpenSettings={onOpenSettings} />)
    const btn = await screen.findByRole('button', { name: /install a pack/i })
    fireEvent.click(btn)
    expect(onOpenSettings).toHaveBeenCalledTimes(1)
  })

  it('omits the install action when no onOpenSettings is provided', async () => {
    window.argus = { packs: { list: vi.fn(async () => ({ packs: [], error: null })) } } as never
    render(<PackStep />)
    await waitFor(() => expect(window.argus.packs.list).toHaveBeenCalled())
    expect(screen.queryByRole('button', { name: /install a pack/i })).toBeNull()
  })
})
