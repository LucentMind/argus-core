// @vitest-environment jsdom
import { render, screen, fireEvent } from '@testing-library/react'
import { describe, it, expect, vi } from 'vitest'
import { Chip, Card, Btn, Checkbox } from '../ui'

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

describe('Checkbox', () => {
  it('stays a real focusable input so label queries and clicks still work', () => {
    const onChange = vi.fn()
    render(
      <Checkbox
        checked={false}
        onChange={onChange}
        label="Show closed"
        aria-label="Show closed cases"
      />
    )
    const input = screen.getByLabelText('Show closed cases')
    expect(input.getAttribute('type')).toBe('checkbox')
    expect(input.className).toContain('sr-only')
    expect(input.className).not.toContain('hidden')
    fireEvent.click(input)
    expect(onChange).toHaveBeenCalledWith(true)
  })

  it('reports the unchecking too', () => {
    const onChange = vi.fn()
    render(
      <Checkbox checked onChange={onChange} label="Show closed" aria-label="Show closed cases" />
    )
    fireEvent.click(screen.getByLabelText('Show closed cases'))
    expect(onChange).toHaveBeenCalledWith(false)
  })
})
