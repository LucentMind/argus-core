// @vitest-environment jsdom
import { render, screen, fireEvent, waitFor } from '@testing-library/react'
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { SessionSwitcher } from '../SessionSwitcher'

const sessions = [
  { id: 2, title: 'Braking RCA', turnCount: 4, updatedAt: '2026-07-11T10:00:00Z' },
  { id: 1, title: '', turnCount: 9, updatedAt: '2026-07-10T10:00:00Z' }
]

beforeEach(() => {
  window.argus = {
    sessions: {
      list: vi.fn(async () => sessions),
      create: vi.fn(async () => ({
        id: 3,
        title: '',
        turnCount: 0,
        updatedAt: '2026-07-11T11:00:00Z'
      })),
      rename: vi.fn(async () => undefined),
      delete: vi.fn(async () => undefined)
    },
    chat: { search: vi.fn(async () => ({ hits: [] })) }
  } as never
})

describe('SessionSwitcher', () => {
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

  it('New Chat creates and switches', async () => {
    const onSwitch = vi.fn()
    render(
      <SessionSwitcher slug="NAV-1" sessionId={1} onSwitch={onSwitch} onJumpToTurn={vi.fn()} />
    )
    fireEvent.click(await screen.findByRole('button', { name: 'New chat' }))
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
    await screen.findByRole('button', { name: /chat 1/i })
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
  // static New Chat button and Search input, swallowing clicks on them while
  // the popup is open. jsdom doesn't do layout/paint, so fireEvent dispatches
  // straight to the target node and can't reproduce that hit-testing bug —
  // assert the structural fix instead: New Chat + Search share a positioned
  // ancestor with a z-index above the overlay's (z-10), and that ancestor
  // does NOT also host the overlay (else the overlay would still out-rank
  // them as a positioned descendant within the same stacking context).
  it('keeps New Chat and Search in a stacking context above the click-away overlay', async () => {
    render(<SessionSwitcher slug="NAV-1" sessionId={1} onSwitch={vi.fn()} onJumpToTurn={vi.fn()} />)
    fireEvent.click(await screen.findByRole('button', { name: /chat 1/i }))
    const newChatButton = screen.getByRole('button', { name: 'New chat' })
    const searchInput = screen.getByLabelText('Search chats')
    const controlsContainer = newChatButton.closest('.relative.z-20')
    expect(controlsContainer).not.toBeNull()
    expect(controlsContainer?.contains(searchInput)).toBe(true)
    // the overlay must live outside this container, or its own positioned
    // descendant status would still out-rank the static button/input inside it
    expect(controlsContainer?.querySelector('.fixed.inset-0')).toBeNull()
  })

  it('Delete confirms, calls sessions.delete, and switches when the active chat was deleted', async () => {
    window.confirm = vi.fn(() => true)
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
    expect(window.confirm).toHaveBeenCalledWith(
      'Delete "Chat 1"? Its transcript and turn history are removed.'
    )
    await waitFor(() =>
      expect((window.argus.sessions as { delete: unknown }).delete).toHaveBeenCalledWith('NAV-1', 1)
    )
    await waitFor(() => expect(onSwitch).toHaveBeenCalledWith(2))
  })

  it('deleting a background chat does not switch; cancel deletes nothing', async () => {
    window.confirm = vi.fn(() => true)
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

    window.confirm = vi.fn(() => false)
    fireEvent.click(await screen.findByRole('button', { name: 'Delete Chat 1' }))
    expect(
      (window.argus.sessions as unknown as { delete: ReturnType<typeof vi.fn> }).delete
    ).toHaveBeenCalledTimes(1)
  })
})
