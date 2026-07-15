// @vitest-environment jsdom
import { render, screen, waitFor } from '@testing-library/react'
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { ClaudeStep } from '../steps'

beforeEach(() => {
  window.argus = {
    agent: {
      authStatus: vi.fn(async () => ({
        ok: true,
        detail: 'ok',
        email: 'x@y.z',
        subscription: 'Max'
      }))
    }
  } as never
})

describe('ClaudeStep', () => {
  it('shows logged-in identity and opens the gate', async () => {
    const setGate = vi.fn()
    render(<ClaudeStep setGate={setGate} />)
    await waitFor(() => expect(screen.getByText(/x@y\.z/)).toBeTruthy())
    expect(setGate).toHaveBeenCalledWith(true)
  })

  it('shows guidance and keeps the gate closed when not logged in', async () => {
    window.argus = {
      agent: { authStatus: vi.fn(async () => ({ ok: false, detail: 'not logged in' })) }
    } as never
    const setGate = vi.fn()
    render(<ClaudeStep setGate={setGate} />)
    await waitFor(() => expect(screen.getByRole('button', { name: /re-check/i })).toBeTruthy())
    expect(setGate).toHaveBeenCalledWith(false)
  })
})
