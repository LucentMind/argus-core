// @vitest-environment jsdom
import { render, screen } from '@testing-library/react'
import { describe, it, expect } from 'vitest'
import '@testing-library/jest-dom/vitest'
import { Btn } from '../ui'

describe('Btn size', () => {
  it('defaults to the h-7 px-3 bar control', () => {
    render(<Btn>Browse</Btn>)
    const cls = screen.getByRole('button').className
    expect(cls).toContain('h-7')
    expect(cls).toContain('px-3')
  })

  it('iconXs replaces the default height and padding rather than appending to them', () => {
    render(<Btn size="iconXs">x</Btn>)
    const cls = screen.getByRole('button').className
    expect(cls).toContain('h-5')
    expect(cls).toContain('w-5')
    // The whole point: the default classes must be GONE, not merely out-ordered.
    expect(cls).not.toContain('h-7')
    expect(cls).not.toContain('px-3')
  })
})
