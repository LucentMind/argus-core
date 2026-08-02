// @vitest-environment jsdom
import '@testing-library/jest-dom/vitest'
import { render, screen, fireEvent, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
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

  it('opens the New panel menu right-aligned so it stays inside the clipped card', async () => {
    // Tasks 4/5's `ml-auto` pushed this trigger to the far right of the bar, and
    // CaseWorkspace's centre card (Task 3) clips overflow instead of letting it spill —
    // a left-aligned (`left-0`) menu would open off the card's right edge and be cut off.
    // `align="right"` resolves to `right-0`, anchoring the menu's right edge to the
    // trigger so it opens leftward, staying inside the card.
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
    fireEvent.click(await screen.findByLabelText('New panel'))
    const menu = await screen.findByRole('menu')
    expect(menu.className).toContain('right-0')
    expect(menu.className).not.toContain('left-0')
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

    // Stays mounted (hidden), not unmounted — remounting re-runs SessionChips' auth/preflight
    // probes (the latter spawns a doctor subprocess) on every chat<->panel toggle. `hidden`,
    // not `not.toBeInTheDocument()`, is the assertion that actually distinguishes the two.
    const chips = await screen.findByTestId('session-chips')
    await waitFor(() => expect(chips).not.toBeVisible())
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

    expect(await screen.findByTestId('session-chips')).toBeVisible()
    // pins Task 4's deviation: SessionSwitcher used to embed its own SessionChips (removed
    // when the switcher moved into the tab strip's always-visible chat tab) — nothing else
    // stops that second copy coming back.
    expect(screen.getAllByTestId('session-chips')).toHaveLength(1)
  })

  it('shows a Find in transcript button on the chat tab and wires it to onOpenFind', async () => {
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
    const onOpenFind = vi.fn()

    const { rerender } = render(
      <PanelTabStrip
        slug="CASE-A"
        sessionId={7}
        activeTab="chat"
        onSelect={vi.fn()}
        activeSessionId={7}
        instanceId={null}
        onSwitchSession={vi.fn()}
        onJumpToTurn={vi.fn()}
        onOpenFind={onOpenFind}
      />
    )

    fireEvent.click(await screen.findByLabelText('Find in transcript'))
    expect(onOpenFind).toHaveBeenCalledTimes(1)

    // absent on a panel tab — the button is chat-only, same as the chips beside it
    rerender(
      <PanelTabStrip
        slug="CASE-A"
        sessionId={7}
        activeTab="sample-pack:text-viewer"
        onSelect={vi.fn()}
        activeSessionId={7}
        instanceId={null}
        onSwitchSession={vi.fn()}
        onJumpToTurn={vi.fn()}
        onOpenFind={onOpenFind}
      />
    )
    expect(screen.queryByLabelText('Find in transcript')).not.toBeInTheDocument()
  })

  it('hides the Find button on the chat tab while no session is active yet', async () => {
    // Gated on activeSessionId !== null, matching SessionChips beside it: with no session
    // resolved (or a sessions.list failure) clicking it would be a no-op, and it would set
    // findOpen true so ChatFind pops open unbidden once a session finally resolves.
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
        onOpenFind={vi.fn()}
      />
    )

    await screen.findByText('Chat') // wait for the strip to settle before asserting absence
    expect(screen.queryByLabelText('Find in transcript')).not.toBeInTheDocument()
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

  it('the null-session fallback is a real, focusable button that selects the chat tab', async () => {
    // Task 4 added a fallback for the brief window before activeSessionId resolves.
    // A previous round made that fallback a <span> — unfocusable, and a silent no-op
    // under `.focus()`, so the earlier version of this test kept passing after the
    // regressed and stayed green even with no tab stop at all. toHaveFocus() is the
    // assertion that would actually fail if the fallback stopped being focusable.
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

    const fallback = await screen.findByRole('button', { name: 'Chat' })
    fallback.focus()
    expect(fallback).toHaveFocus()
    fireEvent.click(fallback)
    expect(onSelect).toHaveBeenCalledWith('chat')
  })

  it('a Space keydown originating in "Search chats" is not cancelled by the tab wrapper', async () => {
    // The wrapper's old onKeyDown had no origin guard, so a Space bubbling up from ANY
    // descendant control (this input included) was cancelled. fireEvent returns false
    // when the event's default was prevented — in a real browser, a prevented keydown
    // blocks both character insertion and the synthesized activation click.
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

    // Search now lives inside SessionSwitcher's popup — open it via the caret (the title
    // button now only selects the chat tab, it no longer toggles the popup).
    fireEvent.click(await screen.findByLabelText('Switch chat'))
    const search = await screen.findByLabelText('Search chats')
    expect(fireEvent.keyDown(search, { key: ' ' })).toBe(true)
  })

  it('clicking the SessionSwitcher click-away overlay while a panel tab is active closes the popup without selecting the chat tab', async () => {
    // SessionSwitcher's click-away overlay is a DOM descendant of the chat-tab wrapper. The
    // wrapper itself no longer carries an onClick, but the overlay must still stopPropagation
    // — otherwise a click meant only to dismiss the popup would bubble into whatever else is
    // listening above it in a real app shell.
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
    const onSelect = vi.fn()

    const { container } = render(
      <PanelTabStrip
        slug="CASE-A"
        sessionId={7}
        activeTab="sample-pack:text-viewer"
        onSelect={onSelect}
        activeSessionId={7}
        instanceId={null}
        onSwitchSession={vi.fn()}
        onJumpToTurn={vi.fn()}
      />
    )

    fireEvent.click(await screen.findByLabelText('Switch chat'))
    expect(await screen.findByRole('group', { name: 'Sessions' })).toBeInTheDocument()
    onSelect.mockClear()

    const overlay = container.querySelector('.fixed.inset-0.z-10')
    expect(overlay).toBeTruthy()
    fireEvent.click(overlay as Element)

    expect(screen.queryByRole('group', { name: 'Sessions' })).not.toBeInTheDocument()
    expect(onSelect).not.toHaveBeenCalled()
  })

  it('an Enter keydown on the SessionSwitcher trigger is not cancelled by the tab wrapper', async () => {
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

    const trigger = await screen.findByLabelText('Ingest triage')
    expect(fireEvent.keyDown(trigger, { key: 'Enter' })).toBe(true)
  })

  it('typing a space into "Search chats" still inserts it', async () => {
    // Unlike fireEvent.change, userEvent.type drives real keydown → (unless prevented)
    // input events, so this reproduces the actual browser breakage: the old handler's
    // preventDefault() suppressed the character insertion, not just the app-level
    // onSelect side effect. Kept under the 3-char search threshold so no debounced
    // window.argus.chat.search call is needed here.
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

    // Search now lives inside SessionSwitcher's popup — open it via the caret.
    fireEvent.click(await screen.findByLabelText('Switch chat'))
    const search = (await screen.findByLabelText('Search chats')) as HTMLInputElement
    await userEvent.type(search, ' a')
    expect(search.value).toBe(' a')
  })

  it('typing a space into the rename input still inserts it', async () => {
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

    fireEvent.click(await screen.findByLabelText('Switch chat'))
    fireEvent.click(await screen.findByRole('button', { name: 'Rename Ingest triage' }))
    const renameInput = screen.getByRole('textbox', {
      name: 'Rename Ingest triage'
    }) as HTMLInputElement
    // Clear first so the assertion isn't sensitive to where userEvent lands the cursor
    // in a pre-filled, autoFocus-ed input — only the space-insertion behaviour matters.
    await userEvent.clear(renameInput)
    await userEvent.type(renameInput, 'x v2')
    expect(renameInput.value).toBe('x v2')
  })

  it('clicking the chat title selects the chat tab without opening the session popup', async () => {
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
    const onSelect = vi.fn()

    render(
      <PanelTabStrip
        slug="CASE-A"
        sessionId={7}
        activeTab="sample-pack:text-viewer"
        onSelect={onSelect}
        activeSessionId={7}
        instanceId={null}
        onSwitchSession={vi.fn()}
        onJumpToTurn={vi.fn()}
      />
    )

    fireEvent.click(await screen.findByLabelText('Ingest triage'))
    expect(onSelect).toHaveBeenCalledWith('chat')
    expect(screen.queryByRole('group', { name: 'Sessions' })).not.toBeInTheDocument()
  })

  it('clicking the caret opens the session popup without selecting the chat tab', async () => {
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
    const onSelect = vi.fn()

    render(
      <PanelTabStrip
        slug="CASE-A"
        sessionId={7}
        activeTab="sample-pack:text-viewer"
        onSelect={onSelect}
        activeSessionId={7}
        instanceId={null}
        onSwitchSession={vi.fn()}
        onJumpToTurn={vi.fn()}
      />
    )

    fireEvent.click(await screen.findByLabelText('Switch chat'))
    expect(await screen.findByRole('group', { name: 'Sessions' })).toBeInTheDocument()
    expect(onSelect).not.toHaveBeenCalled()
  })

  it('choosing a chat from the popup while a panel tab is active switches session and selects the chat tab', async () => {
    window.argus = {
      ...sessionArgusMocks(),
      sessions: {
        list: vi.fn().mockResolvedValue([
          { id: 7, title: 'Ingest triage', turnCount: 3, updatedAt: new Date().toISOString() },
          { id: 9, title: 'Other chat', turnCount: 1, updatedAt: new Date().toISOString() }
        ])
      },
      panels: { open: vi.fn() }
    } as never
    const onSelect = vi.fn()
    const onSwitchSession = vi.fn()

    render(
      <PanelTabStrip
        slug="CASE-A"
        sessionId={7}
        activeTab="sample-pack:text-viewer"
        onSelect={onSelect}
        activeSessionId={7}
        instanceId={null}
        onSwitchSession={onSwitchSession}
        onJumpToTurn={vi.fn()}
      />
    )

    fireEvent.click(await screen.findByLabelText('Switch chat'))
    fireEvent.click(await screen.findByText('Other chat'))
    expect(onSwitchSession).toHaveBeenCalledWith(9)
    expect(onSelect).toHaveBeenCalledWith('chat')
  })

  it('creating a new chat from the popup while a panel tab is active also selects the chat tab', async () => {
    // Same onSwitch path as the "choose an existing chat" case above — `New chat` in
    // SessionSwitcher calls the same onSwitch prop it was handed.
    window.argus = {
      ...sessionArgusMocks(),
      sessions: {
        list: vi
          .fn()
          .mockResolvedValue([
            { id: 7, title: 'Ingest triage', turnCount: 3, updatedAt: new Date().toISOString() }
          ]),
        create: vi.fn().mockResolvedValue({
          id: 11,
          title: '',
          turnCount: 0,
          updatedAt: new Date().toISOString()
        })
      },
      panels: { open: vi.fn() }
    } as never
    const onSelect = vi.fn()
    const onSwitchSession = vi.fn()

    render(
      <PanelTabStrip
        slug="CASE-A"
        sessionId={7}
        activeTab="sample-pack:text-viewer"
        onSelect={onSelect}
        activeSessionId={7}
        instanceId={null}
        onSwitchSession={onSwitchSession}
        onJumpToTurn={vi.fn()}
      />
    )

    fireEvent.click(await screen.findByLabelText('Switch chat'))
    fireEvent.click(await screen.findByRole('button', { name: 'New chat' }))
    await waitFor(() => expect(onSwitchSession).toHaveBeenCalledWith(11))
    expect(onSelect).toHaveBeenCalledWith('chat')
  })

  it('the chat tab wrapper no longer carries a min-w-32 shrink floor', async () => {
    window.argus = { ...sessionArgusMocks(), panels: { open: vi.fn() } } as never
    const { container } = render(
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
    await screen.findByText('Chat')
    const wrapper = container.querySelector('.border-b-2')
    expect(wrapper).toBeTruthy()
    expect(wrapper?.className).not.toContain('min-w-32')
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
