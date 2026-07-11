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
      rename: vi.fn(async () => undefined)
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
    expect(onJump).toHaveBeenCalledWith(2, 20)
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
})
