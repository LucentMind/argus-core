// @vitest-environment jsdom
import { render, screen, fireEvent } from '@testing-library/react'
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { Composer } from '../Composer'
import { uiStore } from '../../lib/uiStore'

beforeEach(() => {
  localStorage.clear()
  uiStore.setShowToolCalls(true)
  window.argus = { skills: { list: vi.fn(async () => []) } } as never
})

describe('Composer', () => {
  it('renders session-option placeholders and lets a value be picked (local only)', () => {
    render(<Composer disabled={false} onSend={vi.fn()} />)
    expect(screen.getByText('Claude Fable 5')).toBeTruthy()
    expect(screen.getByText('High · 200k')).toBeTruthy()
    expect(screen.getByText('Ask approvals')).toBeTruthy()
    fireEvent.click(screen.getByText('Claude Fable 5'))
    fireEvent.click(screen.getByRole('menuitem', { name: 'Claude Sonnet 5' }))
    expect(screen.getByText('Claude Sonnet 5')).toBeTruthy()
    expect(screen.queryByRole('menu')).toBeNull()
  })

  it('tool-results toggle flips uiStore.showToolCalls', () => {
    render(<Composer disabled={false} onSend={vi.fn()} />)
    fireEvent.click(screen.getByRole('button', { name: 'Hide tool results' }))
    expect(uiStore.get().showToolCalls).toBe(false)
    expect(screen.getByRole('button', { name: 'Show tool results' })).toBeTruthy()
    fireEvent.click(screen.getByRole('button', { name: 'Show tool results' }))
    expect(uiStore.get().showToolCalls).toBe(true)
  })

  it('circular send button sends trimmed text and disables when empty', () => {
    const onSend = vi.fn()
    render(<Composer disabled={false} onSend={onSend} />)
    const sendBtn = screen.getByRole('button', { name: 'Send' })
    expect((sendBtn as HTMLButtonElement).disabled).toBe(true)
    fireEvent.change(screen.getByPlaceholderText(/message the analyst/i), {
      target: { value: '  hello  ' }
    })
    expect((sendBtn as HTMLButtonElement).disabled).toBe(false)
    fireEvent.click(sendBtn)
    expect(onSend).toHaveBeenCalledWith('hello')
  })
})
