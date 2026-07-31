// @vitest-environment jsdom
import { render, screen } from '@testing-library/react'
import { describe, it, expect } from 'vitest'
import { StatusDot } from '../StatusDot'

describe('StatusDot', () => {
  it('fills from currentColor so one class drives both dot and glow', () => {
    render(<StatusDot color="text-signal" />)
    const dot = screen.getByTestId('status-dot')
    expect(dot.className).toContain('text-signal')
    expect(dot.className).toContain('bg-current')
    expect(dot.className).toContain('argus-dot')
  })

  it('is decorative — the adjacent word carries the meaning', () => {
    render(<StatusDot color="text-defect" />)
    expect(screen.getByTestId('status-dot').getAttribute('aria-hidden')).toBe('true')
  })

  it('takes an explicit size', () => {
    render(<StatusDot color="text-defect" size={6} />)
    expect(screen.getByTestId('status-dot').style.width).toBe('6px')
  })
})
