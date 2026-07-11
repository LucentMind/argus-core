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
})
