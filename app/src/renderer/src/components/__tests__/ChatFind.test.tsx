// @vitest-environment jsdom
import { render, screen, fireEvent } from '@testing-library/react'
import { describe, it, expect, vi } from 'vitest'
import { ChatFind } from '../ChatFind'

const items = [
  { kind: 'user' as const, text: 'braking failed', turnId: 1 },
  { kind: 'assistant' as const, text: 'checking braking logs', streaming: false },
  { kind: 'user' as const, text: 'unrelated', turnId: 2 }
]

describe('ChatFind', () => {
  it('shows match count and navigates with wrap-around', () => {
    const onNavigate = vi.fn()
    render(<ChatFind items={items} onNavigate={onNavigate} onClose={vi.fn()} />)
    fireEvent.change(screen.getByLabelText('Find in chat'), { target: { value: 'braking' } })
    expect(screen.getByText('1/2')).toBeTruthy()
    expect(onNavigate).toHaveBeenLastCalledWith(0)
    fireEvent.keyDown(screen.getByLabelText('Find in chat'), { key: 'Enter' })
    expect(screen.getByText('2/2')).toBeTruthy()
    expect(onNavigate).toHaveBeenLastCalledWith(1)
    fireEvent.keyDown(screen.getByLabelText('Find in chat'), { key: 'Enter' })
    expect(screen.getByText('1/2')).toBeTruthy() // wrapped
    fireEvent.keyDown(screen.getByLabelText('Find in chat'), { key: 'Enter', shiftKey: true })
    expect(screen.getByText('2/2')).toBeTruthy() // backwards wrap
  })

  it('Escape closes', () => {
    const onClose = vi.fn()
    render(<ChatFind items={items} onNavigate={vi.fn()} onClose={onClose} />)
    fireEvent.keyDown(screen.getByLabelText('Find in chat'), { key: 'Escape' })
    expect(onClose).toHaveBeenCalled()
  })
})
