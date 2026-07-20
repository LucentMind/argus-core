// @vitest-environment jsdom
import { render, screen, fireEvent, waitFor } from '@testing-library/react'
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { SessionSwitcher } from '../SessionSwitcher'
import { settingsStore } from '../../lib/settingsStore'
import { confirm } from '../../lib/confirmStore'
import { defaultSettings } from '../../../../shared/settings'

vi.mock('../../lib/confirmStore', () => ({
  confirm: vi.fn(() => Promise.resolve(true)),
  alert: vi.fn(() => Promise.resolve())
}))

const sessions = [
  {
    id: 2,
    title: 'Braking RCA',
    turnCount: 4,
    updatedAt: '2026-07-11T10:00:00Z',
    driverKind: 'claude-agent-sdk'
  },
  {
    id: 1,
    title: '',
    turnCount: 9,
    updatedAt: '2026-07-10T10:00:00Z',
    driverKind: 'claude-agent-sdk'
  }
]

beforeEach(() => {
  settingsStore.reset()
  window.argus = {
    sessions: {
      list: vi.fn(async () => sessions),
      create: vi.fn(async () => ({
        id: 3,
        title: '',
        turnCount: 0,
        updatedAt: '2026-07-11T11:00:00Z',
        driverKind: 'claude-agent-sdk'
      })),
      rename: vi.fn(async () => undefined),
      delete: vi.fn(async () => undefined)
    },
    chat: { search: vi.fn(async () => ({ hits: [] })) },
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
  } as never
})

describe('SessionSwitcher', () => {
  it('shows no driver badge when every session matches the active driver', async () => {
    render(<SessionSwitcher slug="NAV-1" sessionId={1} onSwitch={vi.fn()} onJumpToTurn={vi.fn()} />)
    fireEvent.click(await screen.findByRole('button', { name: /chat 1/i }))
    expect(screen.queryByText('Copilot')).toBeNull()
    expect(screen.queryByText('Claude')).toBeNull()
  })

  it('badges a session whose driverKind differs from the active driver, not the matching one', async () => {
    window.argus.sessions.list = vi.fn(async () => [
      { ...sessions[0], driverKind: 'github-copilot' }, // differs → badged
      sessions[1] // matches claude-agent-sdk (the default active instance) → no badge
    ]) as never
    render(<SessionSwitcher slug="NAV-1" sessionId={1} onSwitch={vi.fn()} onJumpToTurn={vi.fn()} />)
    fireEvent.click(await screen.findByRole('button', { name: /chat 1/i }))
    expect(await screen.findByText('Copilot')).toBeTruthy()
    expect(screen.queryByText('Claude')).toBeNull()
  })

  it('shows the active driver badge on the trigger when the active session itself differs', async () => {
    window.argus.sessions.list = vi.fn(async () => [
      { ...sessions[1], id: 1, driverKind: 'github-copilot' }
    ]) as never
    render(<SessionSwitcher slug="NAV-1" sessionId={1} onSwitch={vi.fn()} onJumpToTurn={vi.fn()} />)
    expect(await screen.findByText('Copilot')).toBeTruthy()
  })

  it('shows the active session title; untitled falls back to Chat <id>', async () => {
    render(<SessionSwitcher slug="NAV-1" sessionId={1} onSwitch={vi.fn()} onJumpToTurn={vi.fn()} />)
    expect(await screen.findByText('Chat 1')).toBeTruthy()
  })

  it('lists sessions on open and switches on click', async () => {
    const onSwitch = vi.fn()
    render(
      <SessionSwitcher slug="NAV-1" sessionId={1} onSwitch={onSwitch} onJumpToTurn={vi.fn()} />
    )
    fireEvent.click(await screen.findByRole('button', { name: /chat 1/i }))
    fireEvent.click(await screen.findByText('Braking RCA'))
    expect(onSwitch).toHaveBeenCalledWith(2)
  })

  it('New Chat is the first entry in the popup; creates and switches', async () => {
    const onSwitch = vi.fn()
    render(
      <SessionSwitcher slug="NAV-1" sessionId={1} onSwitch={onSwitch} onJumpToTurn={vi.fn()} />
    )
    // the button lives inside the popup now, not beside the trigger
    expect(screen.queryByRole('button', { name: 'New chat' })).toBeNull()
    fireEvent.click(await screen.findByRole('button', { name: /chat 1/i }))
    const panel = screen.getByRole('group', { name: 'Sessions' })
    const buttons = panel.querySelectorAll('button')
    expect(buttons[0].getAttribute('aria-label')).toBe('New chat')
    fireEvent.click(buttons[0])
    await waitFor(() => expect(onSwitch).toHaveBeenCalledWith(3))
  })

  it('search stays inactive below 3 characters', async () => {
    render(<SessionSwitcher slug="NAV-1" sessionId={1} onSwitch={vi.fn()} onJumpToTurn={vi.fn()} />)
    fireEvent.click(await screen.findByRole('button', { name: /chat 1/i }))
    fireEvent.change(screen.getByLabelText('Search chats'), { target: { value: 'br' } })
    // outlast the 200ms debounce — the search must never fire for a 2-char query
    await new Promise((r) => setTimeout(r, 300))
    expect(window.argus.chat.search).not.toHaveBeenCalled()
    // panel stays in list mode
    expect(screen.getByText('Braking RCA')).toBeTruthy()
  })

  it('closing the popup exits an in-progress rename', async () => {
    render(<SessionSwitcher slug="NAV-1" sessionId={1} onSwitch={vi.fn()} onJumpToTurn={vi.fn()} />)
    const trigger = await screen.findByRole('button', { name: /chat 1/i })
    fireEvent.click(trigger)
    fireEvent.click(await screen.findByRole('button', { name: 'Rename Braking RCA' }))
    expect(screen.getByRole('textbox', { name: 'Rename Braking RCA' })).toBeTruthy()
    fireEvent.click(trigger) // close
    fireEvent.click(trigger) // reopen
    expect(screen.queryByRole('textbox', { name: 'Rename Braking RCA' })).toBeNull()
    expect(await screen.findByText('Braking RCA')).toBeTruthy()
  })

  it('New chat reuses an existing untouched chat instead of creating another', async () => {
    window.argus.sessions.list = vi.fn(async () => [
      { id: 5, title: '', turnCount: 0, updatedAt: '2026-07-11T12:00:00Z' },
      ...sessions
    ]) as never
    const onSwitch = vi.fn()
    render(
      <SessionSwitcher slug="NAV-1" sessionId={1} onSwitch={onSwitch} onJumpToTurn={vi.fn()} />
    )
    // wait for the list fetch so the empty chat is known
    fireEvent.click(await screen.findByRole('button', { name: /chat 1/i }))
    fireEvent.click(screen.getByRole('button', { name: 'New chat' }))
    await waitFor(() => expect(onSwitch).toHaveBeenCalledWith(5))
    expect(window.argus.sessions.create).not.toHaveBeenCalled()
  })

  it('renaming an untitled chat starts from an empty field, not the Chat <id> placeholder', async () => {
    render(<SessionSwitcher slug="NAV-1" sessionId={2} onSwitch={vi.fn()} onJumpToTurn={vi.fn()} />)
    fireEvent.click(await screen.findByRole('button', { name: /braking rca/i }))
    fireEvent.click(await screen.findByRole('button', { name: 'Rename Chat 1' }))
    const input = screen.getByRole('textbox', { name: 'Rename Chat 1' }) as HTMLInputElement
    expect(input.value).toBe('')
  })

  it('renames inline', async () => {
    render(<SessionSwitcher slug="NAV-1" sessionId={1} onSwitch={vi.fn()} onJumpToTurn={vi.fn()} />)
    fireEvent.click(await screen.findByRole('button', { name: /chat 1/i }))
    fireEvent.click(await screen.findByRole('button', { name: 'Rename Braking RCA' }))
    const input = screen.getByDisplayValue('Braking RCA')
    fireEvent.change(input, { target: { value: 'Tunnel case' } })
    fireEvent.keyDown(input, { key: 'Enter' })
    await waitFor(() => expect(window.argus.sessions.rename).toHaveBeenCalledWith(2, 'Tunnel case'))
  })

  it('typing switches the panel to grouped results; clicking a hit jumps', async () => {
    window.argus.chat.search = vi.fn(async () => ({
      hits: [{ sessionId: 2, turnId: 20, role: 'assistant', snippet: '«braking» pressure log' }]
    }))
    const onJump = vi.fn()
    render(<SessionSwitcher slug="NAV-1" sessionId={1} onSwitch={vi.fn()} onJumpToTurn={onJump} />)
    fireEvent.click(await screen.findByRole('button', { name: /chat 1/i }))
    fireEvent.change(screen.getByLabelText('Search chats'), { target: { value: 'braking' } })
    fireEvent.click(await screen.findByText(/pressure log/))
    // role + snippet travel with the jump so ChatPane can land on the matched
    // message (assistant text has no per-message id — it's resolved in-turn)
    expect(onJump).toHaveBeenCalledWith(2, {
      turnId: 20,
      role: 'assistant',
      snippet: '«braking» pressure log'
    })
  })

  it('shows the FTS error inline', async () => {
    window.argus.chat.search = vi.fn(async () => ({ hits: [], error: 'fts5: syntax error' }))
    render(<SessionSwitcher slug="NAV-1" sessionId={1} onSwitch={vi.fn()} onJumpToTurn={vi.fn()} />)
    fireEvent.click(await screen.findByRole('button', { name: /chat 1/i }))
    fireEvent.change(screen.getByLabelText('Search chats'), { target: { value: '"bad' } })
    expect(await screen.findByText(/syntax error/)).toBeTruthy()
  })

  // The click-away overlay (`fixed inset-0 z-10`) sits above the header's
  // static Search input, swallowing clicks on it while the popup is open.
  // jsdom doesn't do layout/paint, so fireEvent dispatches straight to the
  // target node and can't reproduce that hit-testing bug — assert the
  // structural fix instead: Search has a positioned ancestor with a z-index
  // above the overlay's (z-10), and that ancestor does NOT also host the
  // overlay (else the overlay would still out-rank it as a positioned
  // descendant within the same stacking context).
  it('keeps Search in a stacking context above the click-away overlay', async () => {
    render(<SessionSwitcher slug="NAV-1" sessionId={1} onSwitch={vi.fn()} onJumpToTurn={vi.fn()} />)
    fireEvent.click(await screen.findByRole('button', { name: /chat 1/i }))
    const searchInput = screen.getByLabelText('Search chats')
    const controlsContainer = searchInput.closest('.relative.z-20')
    expect(controlsContainer).not.toBeNull()
    // the overlay must live outside this container, or its own positioned
    // descendant status would still out-rank the static input inside it
    expect(controlsContainer?.querySelector('.fixed.inset-0')).toBeNull()
  })

  it('Delete confirms, calls sessions.delete, and switches when the active chat was deleted', async () => {
    vi.mocked(confirm).mockResolvedValue(true)
    const onSwitch = vi.fn()
    ;(window.argus.sessions as unknown as { list: ReturnType<typeof vi.fn> }).list = vi
      .fn()
      .mockResolvedValueOnce(sessions) // initial mount
      .mockResolvedValueOnce(sessions) // popup open
      .mockResolvedValue([sessions[0]]) // after delete: only id 2 remains
    render(
      <SessionSwitcher slug="NAV-1" sessionId={1} onSwitch={onSwitch} onJumpToTurn={vi.fn()} />
    )
    fireEvent.click(await screen.findByRole('button', { name: /chat 1/i }))
    fireEvent.click(await screen.findByRole('button', { name: 'Delete Chat 1' }))
    expect(confirm).toHaveBeenCalledWith(
      expect.objectContaining({
        title: 'Delete "Chat 1"?',
        message: 'Its transcript and turn history are removed.'
      })
    )
    await waitFor(() =>
      expect((window.argus.sessions as { delete: unknown }).delete).toHaveBeenCalledWith('NAV-1', 1)
    )
    await waitFor(() => expect(onSwitch).toHaveBeenCalledWith(2))
  })

  it('deleting a background chat does not switch; cancel deletes nothing', async () => {
    vi.mocked(confirm).mockResolvedValue(true)
    const onSwitch = vi.fn()
    render(
      <SessionSwitcher slug="NAV-1" sessionId={1} onSwitch={onSwitch} onJumpToTurn={vi.fn()} />
    )
    fireEvent.click(await screen.findByRole('button', { name: /chat 1/i }))
    fireEvent.click(await screen.findByRole('button', { name: 'Delete Braking RCA' }))
    await waitFor(() =>
      expect((window.argus.sessions as { delete: unknown }).delete).toHaveBeenCalledWith('NAV-1', 2)
    )
    expect(onSwitch).not.toHaveBeenCalled()

    vi.mocked(confirm).mockResolvedValue(false)
    const confirmsBefore = vi.mocked(confirm).mock.calls.length
    fireEvent.click(await screen.findByRole('button', { name: 'Delete Chat 1' }))
    await waitFor(() => expect(vi.mocked(confirm).mock.calls.length).toBe(confirmsBefore + 1))
    expect(
      (window.argus.sessions as unknown as { delete: ReturnType<typeof vi.fn> }).delete
    ).toHaveBeenCalledTimes(1)
  })

  it('shows an inline error and still refetches the list when sessions.delete rejects', async () => {
    vi.mocked(confirm).mockResolvedValue(true)
    const onSwitch = vi.fn()
    window.argus.sessions.delete = vi.fn(async () => {
      throw new Error('chat locked')
    })
    render(
      <SessionSwitcher slug="NAV-1" sessionId={1} onSwitch={onSwitch} onJumpToTurn={vi.fn()} />
    )
    fireEvent.click(await screen.findByRole('button', { name: /chat 1/i }))
    const listCallsBefore = (window.argus.sessions.list as ReturnType<typeof vi.fn>).mock.calls
      .length
    fireEvent.click(await screen.findByRole('button', { name: 'Delete Chat 1' }))
    expect(await screen.findByText('chat locked')).toBeTruthy()
    // failed delete must not switch away from the still-live active session
    expect(onSwitch).not.toHaveBeenCalled()
    await waitFor(() =>
      expect(
        (window.argus.sessions.list as ReturnType<typeof vi.fn>).mock.calls.length
      ).toBeGreaterThan(listCallsBefore)
    )
  })
})
