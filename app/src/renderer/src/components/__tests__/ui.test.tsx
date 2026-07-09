// @vitest-environment jsdom
import { render, screen } from '@testing-library/react'
import { describe, it, expect } from 'vitest'
import { Chip, Card, Btn } from '../ui'

describe('ui primitives', () => {
  it('renders a Chip with tone styling', () => {
    render(<Chip tone="defect">MEDIUM</Chip>)
    const el = screen.getByText('MEDIUM')
    expect(el.className).toContain('text-defect')
  })
  it('renders Card and Btn', () => {
    render(
      <Card>
        <Btn variant="primary">Go</Btn>
      </Card>
    )
    expect(screen.getByRole('button', { name: 'Go' })).toBeTruthy()
  })
})
