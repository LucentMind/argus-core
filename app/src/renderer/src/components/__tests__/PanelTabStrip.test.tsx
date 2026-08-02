// @vitest-environment jsdom
import '@testing-library/jest-dom/vitest'
import { render, screen, fireEvent, waitFor } from '@testing-library/react'
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { PanelTabStrip } from '../PanelTabStrip'
import { panelsStore } from '../../lib/panelsStore'
import { externalAppsStore } from '../../lib/externalAppsStore'
import { settingsStore } from '../../lib/settingsStore'
import { defaultSettings } from '../../../../shared/settings'

// window.argus baseline needed whenever the strip can mount either session-scoped piece:
// SessionSwitcher (activeSessionId !== null — reads settingsStore for the driver badge) or
// the state zone's own SessionChips (activeTab === 'chat' AND activeSessionId !== null — it
// probes auth/preflight once a session exists). Tests that keep activeSessionId: null never
// mount either piece and so don't strictly need these mocks, but the baseline is kept uniform
// across this file for simplicity. Same mocks ChatPane.test.tsx and SessionSwitcher.test.tsx
// carry for the same reason.
function sessionArgusMocks(): Record<string, unknown> {
  return {
    agent: {
      authStatus: vi.fn(async () => ({ ok: true, verified: true, detail: 'claude ready' })),
      preflight: vi.fn(async () => ({ ok: true, checks: [] })),
      onAuthChanged: vi.fn(() => () => {})
    },
    settings: {
      get: vi.fn(async () => ({
        settings: defaultSettings(),
        resolvedTools: [],
        dataRoot: { path: 'C:\\x', fromEnv: false },
        loadError: null
      })),
      patch: vi.fn(),
      onChanged: vi.fn(() => () => {})
    }
  }
}

beforeEach(() => {
  // panelsStore is a module-level singleton shared with the real app; seed it
  // fresh for each test so a launcher item is always available to click.
  panelsStore.setCase('CASE-A')
  panelsStore.setDecls([
    {
      packId: 'sample-pack',
      windowId: 'text-viewer',
      title: 'Text Viewer',
      handles: [],
      kind: 'webPanel'
    }
  ])
  panelsStore.setPanels([])
  settingsStore.reset()
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
    window.argus = { ...sessionArgusMocks(), panels: { open } } as never

    render(
      <PanelTabStrip
        slug="CASE-A"
        sessionId={42}
        activeTab="chat"
        onSelect={vi.fn()}
        activeSessionId={null}
        instanceId={null}
        onSwitchSession={vi.fn()}
        onJumpToTurn={vi.fn()}
      />
    )

    fireEvent.click(screen.getByLabelText('New panel'))
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

  it('occludes docked panels while the launcher menu is open, releasing on close', async () => {
    // The launcher dropdown is DOM; a docked panel's native view would paint over it. Opening the
    // menu must occlude (hide) the docked view so the dropdown is clickable — else you can never
    // open a second panel once the first is docked.
    window.argus = {
      ...sessionArgusMocks(),
      panels: { open: vi.fn().mockResolvedValue({}) }
    } as never
    render(
      <PanelTabStrip
        slug="CASE-A"
        sessionId={1}
        activeTab="chat"
        onSelect={vi.fn()}
        activeSessionId={null}
        instanceId={null}
        onSwitchSession={vi.fn()}
        onJumpToTurn={vi.fn()}
      />
    )

    expect(panelsStore.get().occluded).toBe(false)
    fireEvent.click(screen.getByLabelText('New panel'))
    expect(panelsStore.get().occluded).toBe(true)
    fireEvent.keyDown(document, { key: 'Escape' })
    await waitFor(() => expect(panelsStore.get().occluded).toBe(false))
  })

  it('passes a null sessionId through unchanged when no session is active yet', async () => {
    const open = vi.fn().mockResolvedValue({
      caseSlug: 'CASE-A',
      packId: 'sample-pack',
      windowId: 'text-viewer',
      title: 'Text Viewer',
      floated: false
    })
    window.argus = { ...sessionArgusMocks(), panels: { open } } as never

    render(
      <PanelTabStrip
        slug="CASE-A"
        sessionId={null}
        activeTab="chat"
        onSelect={vi.fn()}
        activeSessionId={null}
        instanceId={null}
        onSwitchSession={vi.fn()}
        onJumpToTurn={vi.fn()}
      />
    )

    fireEvent.click(screen.getByLabelText('New panel'))
    fireEvent.click(await screen.findByRole('menuitem', { name: 'Text Viewer' }))

    await waitFor(() =>
      expect(open).toHaveBeenCalledWith(expect.objectContaining({ sessionId: null }))
    )
  })

  it('renders the New panel launcher when no action is supplied', async () => {
    window.argus = { ...sessionArgusMocks(), panels: { open: vi.fn() } } as never
    render(
      <PanelTabStrip
        slug="case-a"
        sessionId={1}
        activeTab="chat"
        onSelect={() => {}}
        activeSessionId={null}
        instanceId={null}
        onSwitchSession={vi.fn()}
        onJumpToTurn={vi.fn()}
      />
    )
    expect(await screen.findByLabelText('New panel')).toBeTruthy()
  })

  it('replaces the launcher with the supplied action', async () => {
    window.argus = { ...sessionArgusMocks(), panels: { open: vi.fn() } } as never
    render(
      <PanelTabStrip
        slug="case-a"
        sessionId={1}
        activeTab="chat"
        onSelect={() => {}}
        activeSessionId={null}
        instanceId={null}
        onSwitchSession={vi.fn()}
        onJumpToTurn={vi.fn()}
        action={<button type="button">Run review</button>}
      />
    )
    expect(await screen.findByText('Run review')).toBeTruthy()
    expect(screen.queryByLabelText('New panel')).toBeNull()
  })

  it('renders the active chat title as the active tab', async () => {
    window.argus = {
      ...sessionArgusMocks(),
      sessions: {
        list: vi
          .fn()
          .mockResolvedValue([
            { id: 7, title: 'Ingest triage', turnCount: 3, updatedAt: new Date().toISOString() }
          ])
      },
      panels: { open: vi.fn() }
    } as never

    render(
      <PanelTabStrip
        slug="CASE-A"
        sessionId={7}
        activeTab="chat"
        onSelect={vi.fn()}
        activeSessionId={7}
        instanceId={null}
        onSwitchSession={vi.fn()}
        onJumpToTurn={vi.fn()}
      />
    )

    expect(await screen.findByLabelText('Ingest triage')).toBeInTheDocument()
  })

  it('hides chat state chips while a panel tab is active', async () => {
    window.argus = {
      ...sessionArgusMocks(),
      sessions: {
        list: vi
          .fn()
          .mockResolvedValue([
            { id: 7, title: 'Ingest triage', turnCount: 3, updatedAt: new Date().toISOString() }
          ])
      },
      panels: { open: vi.fn() }
    } as never

    render(
      <PanelTabStrip
        slug="CASE-A"
        sessionId={7}
        activeTab="sample-pack:text-viewer"
        onSelect={vi.fn()}
        activeSessionId={7}
        instanceId={null}
        onSwitchSession={vi.fn()}
        onJumpToTurn={vi.fn()}
      />
    )

    await waitFor(() => expect(screen.queryByTestId('session-chips')).not.toBeInTheDocument())
  })

  it('shows chat state chips exactly once when the chat tab is active with a real session', async () => {
    window.argus = {
      ...sessionArgusMocks(),
      sessions: {
        list: vi
          .fn()
          .mockResolvedValue([
            { id: 7, title: 'Ingest triage', turnCount: 3, updatedAt: new Date().toISOString() }
          ])
      },
      panels: { open: vi.fn() }
    } as never

    render(
      <PanelTabStrip
        slug="CASE-A"
        sessionId={7}
        activeTab="chat"
        onSelect={vi.fn()}
        activeSessionId={7}
        instanceId={null}
        onSwitchSession={vi.fn()}
        onJumpToTurn={vi.fn()}
      />
    )

    expect(await screen.findByTestId('session-chips')).toBeInTheDocument()
    // pins Task 4's deviation: SessionSwitcher used to embed its own SessionChips (removed
    // when the switcher moved into the tab strip's always-visible chat tab) — nothing else
    // stops that second copy coming back.
    expect(screen.getAllByTestId('session-chips')).toHaveLength(1)
  })

  it('shows no chips and a fallback "Chat" label while no session is active yet', async () => {
    window.argus = {
      ...sessionArgusMocks(),
      sessions: { list: vi.fn().mockResolvedValue([]) },
      panels: { open: vi.fn() }
    } as never

    render(
      <PanelTabStrip
        slug="CASE-A"
        sessionId={null}
        activeTab="chat"
        onSelect={vi.fn()}
        activeSessionId={null}
        instanceId={null}
        onSwitchSession={vi.fn()}
        onJumpToTurn={vi.fn()}
      />
    )

    // the tab must never be an empty, unlabelled box — "Chat" is the pre-Task-4 fallback
    expect(await screen.findByText('Chat')).toBeInTheDocument()
    expect(screen.queryByTestId('session-chips')).not.toBeInTheDocument()
  })

  it('the chat tab is keyboard-operable even with no active session', async () => {
    const onSelect = vi.fn()
    window.argus = {
      ...sessionArgusMocks(),
      sessions: { list: vi.fn().mockResolvedValue([]) },
      panels: { open: vi.fn() }
    } as never

    render(
      <PanelTabStrip
        slug="CASE-A"
        sessionId={null}
        activeTab="sample-pack:text-viewer"
        onSelect={onSelect}
        activeSessionId={null}
        instanceId={null}
        onSwitchSession={vi.fn()}
        onJumpToTurn={vi.fn()}
      />
    )

    const tab = await screen.findByRole('tab')
    expect(tab).toHaveAttribute('aria-selected', 'false')
    tab.focus()
    fireEvent.keyDown(tab, { key: 'Enter' })
    expect(onSelect).toHaveBeenCalledWith('chat')
  })
})

describe('PanelTabStrip — externalApp (3c)', () => {
  beforeEach(() => {
    settingsStore.reset()
    window.argus = {
      ...sessionArgusMocks(),
      externalApps: {
        open: vi.fn().mockResolvedValue({ ok: true }),
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

  it('renders a running app as a presence chip with Stop and no Focus button', () => {
    render(
      <PanelTabStrip
        slug="CASE-A"
        sessionId={1}
        activeTab="chat"
        onSelect={vi.fn()}
        activeSessionId={null}
        instanceId={null}
        onSwitchSession={vi.fn()}
        onJumpToTurn={vi.fn()}
      />
    )
    expect(screen.getByText('Sim')).toBeInTheDocument()
    expect(screen.queryByLabelText('Focus Sim')).not.toBeInTheDocument()
    fireEvent.click(screen.getByLabelText('Stop Sim'))
    expect(window.argus.externalApps.stop).toHaveBeenCalledWith({
      caseSlug: 'CASE-A',
      packId: 'ext',
      windowId: 'sim'
    })
  })

  it('launching an externalApp decl calls externalApps.open, not panels.open', async () => {
    render(
      <PanelTabStrip
        slug="CASE-A"
        sessionId={1}
        activeTab="chat"
        onSelect={vi.fn()}
        activeSessionId={null}
        instanceId={null}
        onSwitchSession={vi.fn()}
        onJumpToTurn={vi.fn()}
      />
    )
    fireEvent.click(screen.getByLabelText('New panel'))
    fireEvent.click(await screen.findByRole('menuitem', { name: 'Sim' }))
    await waitFor(() => expect(window.argus.externalApps.open).toHaveBeenCalled())
    expect(window.argus.panels.open).not.toHaveBeenCalled()
  })

  it('renders an exited app as a muted chip with no Focus button, and Stop dismisses it', () => {
    externalAppsStore.setApps([
      { caseSlug: 'CASE-A', packId: 'ext', windowId: 'sim', title: 'Sim', status: 'exited' }
    ])
    render(
      <PanelTabStrip
        slug="CASE-A"
        sessionId={1}
        activeTab="chat"
        onSelect={vi.fn()}
        activeSessionId={null}
        instanceId={null}
        onSwitchSession={vi.fn()}
        onJumpToTurn={vi.fn()}
      />
    )
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
