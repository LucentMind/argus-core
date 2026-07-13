// @vitest-environment jsdom
import '@testing-library/jest-dom/vitest'
import { render, screen, fireEvent, waitFor } from '@testing-library/react'
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { PanelTabStrip } from '../PanelTabStrip'
import { panelsStore } from '../../lib/panelsStore'
import { externalAppsStore } from '../../lib/externalAppsStore'

beforeEach(() => {
  // panelsStore is a module-level singleton shared with the real app; seed it
  // fresh for each test so a launcher item is always available to click.
  panelsStore.setCase('CASE-A')
  panelsStore.setDecls([
    { packId: 'sample-pack', windowId: 'text-viewer', title: 'Text Viewer', handles: [], kind: 'webPanel' }
  ])
  panelsStore.setPanels([])
})

describe('PanelTabStrip', () => {
  it('passes the active sessionId when opening a panel from the launcher', async () => {
    const open = vi.fn().mockResolvedValue({
      caseSlug: 'CASE-A',
      packId: 'sample-pack',
      windowId: 'text-viewer',
      title: 'Text Viewer',
      floated: false
    })
    window.argus = { panels: { open } } as never

    render(<PanelTabStrip slug="CASE-A" sessionId={42} activeTab="chat" onSelect={vi.fn()} />)

    fireEvent.click(screen.getByLabelText('Open panel'))
    fireEvent.click(await screen.findByRole('menuitem', { name: 'Text Viewer' }))

    await waitFor(() =>
      expect(open).toHaveBeenCalledWith(
        expect.objectContaining({
          caseSlug: 'CASE-A',
          packId: 'sample-pack',
          windowId: 'text-viewer',
          sessionId: 42
        })
      )
    )
  })

  it('passes a null sessionId through unchanged when no session is active yet', async () => {
    const open = vi.fn().mockResolvedValue({
      caseSlug: 'CASE-A',
      packId: 'sample-pack',
      windowId: 'text-viewer',
      title: 'Text Viewer',
      floated: false
    })
    window.argus = { panels: { open } } as never

    render(<PanelTabStrip slug="CASE-A" sessionId={null} activeTab="chat" onSelect={vi.fn()} />)

    fireEvent.click(screen.getByLabelText('Open panel'))
    fireEvent.click(await screen.findByRole('menuitem', { name: 'Text Viewer' }))

    await waitFor(() =>
      expect(open).toHaveBeenCalledWith(expect.objectContaining({ sessionId: null }))
    )
  })
})

describe('PanelTabStrip — externalApp (3c)', () => {
  beforeEach(() => {
    window.argus = {
      externalApps: {
        open: vi.fn().mockResolvedValue({ ok: true }),
        focus: vi.fn(),
        stop: vi.fn()
      },
      panels: { open: vi.fn().mockResolvedValue({}), onChanged: () => () => {} }
    } as never
    panelsStore.setCase('CASE-A')
    panelsStore.setDecls([
      { packId: 'ext', windowId: 'sim', title: 'Sim', handles: [], kind: 'externalApp' }
    ])
    externalAppsStore.setCase('CASE-A')
    externalAppsStore.setApps([
      { caseSlug: 'CASE-A', packId: 'ext', windowId: 'sim', title: 'Sim', status: 'running' }
    ])
  })

  it('renders a running app as a presence chip with Stop', () => {
    render(<PanelTabStrip slug="CASE-A" sessionId={1} activeTab="chat" onSelect={vi.fn()} />)
    expect(screen.getByText('Sim')).toBeInTheDocument()
    fireEvent.click(screen.getByLabelText('Stop Sim'))
    expect(window.argus.externalApps.stop).toHaveBeenCalledWith({
      caseSlug: 'CASE-A',
      packId: 'ext',
      windowId: 'sim'
    })
  })

  it('launching an externalApp decl calls externalApps.open, not panels.open', async () => {
    render(<PanelTabStrip slug="CASE-A" sessionId={1} activeTab="chat" onSelect={vi.fn()} />)
    fireEvent.click(screen.getByLabelText('Open panel'))
    fireEvent.click(await screen.findByRole('menuitem', { name: 'Sim' }))
    await waitFor(() => expect(window.argus.externalApps.open).toHaveBeenCalled())
    expect(window.argus.panels.open).not.toHaveBeenCalled()
  })

  it('renders an exited app as a muted chip with no Focus button, and Stop dismisses it', () => {
    externalAppsStore.setApps([
      { caseSlug: 'CASE-A', packId: 'ext', windowId: 'sim', title: 'Sim', status: 'exited' }
    ])
    render(<PanelTabStrip slug="CASE-A" sessionId={1} activeTab="chat" onSelect={vi.fn()} />)
    expect(screen.getByText('Sim')).toBeInTheDocument()
    expect(screen.queryByLabelText('Focus Sim')).not.toBeInTheDocument()
    const dot = document.querySelector('.bg-mute')
    expect(dot).toBeInTheDocument()
    fireEvent.click(screen.getByLabelText('Stop Sim'))
    expect(window.argus.externalApps.stop).toHaveBeenCalledWith({
      caseSlug: 'CASE-A',
      packId: 'ext',
      windowId: 'sim'
    })
  })
})
