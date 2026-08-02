// @vitest-environment jsdom
import { render, screen, fireEvent } from '@testing-library/react'
import { describe, it, expect, vi } from 'vitest'
import { Chip, Card, Btn, Checkbox, Toggle } from '../ui'

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

describe('Toggle', () => {
  it('exposes its state through the switch role, not a hidden input', () => {
    const onChange = vi.fn()
    render(
      <Toggle checked={false} onChange={onChange} label="Show closed" aria-label="Show closed" />
    )
    // A switch, not a checkbox: this takes effect the moment it moves, where a checkbox states a
    // value something else reads later. `getByRole('switch', { checked })` is what makes the
    // distinction assertable at all — Checkbox's sr-only input would answer to 'checkbox'.
    const el = screen.getByRole('switch', { name: 'Show closed', checked: false })
    fireEvent.click(el)
    expect(onChange).toHaveBeenCalledWith(true)
  })

  it('moves the knob and fills the track when on', () => {
    const { rerender } = render(
      <Toggle checked={false} onChange={vi.fn()} label="Show closed" aria-label="Show closed" />
    )
    const track = (): HTMLElement => screen.getByRole('switch').querySelector('span') as HTMLElement
    const knob = (): HTMLElement => track().querySelector('span') as HTMLElement
    // Off: knob parked left, track unfilled.
    expect(knob().className).toContain('translate-x-[2px]')
    expect(track().className).not.toContain('bg-signal')

    rerender(<Toggle checked onChange={vi.fn()} label="Show closed" aria-label="Show closed" />)
    // On: knob travelled, track carries the signal tint. Both are React-state reads, which is
    // the reason this is a button and not a `peer-checked:` input — the knob is a DESCENDANT of
    // the track, and `peer-*` only ever matches later siblings.
    expect(knob().className).toContain('translate-x-[14px]')
    expect(track().className).toContain('bg-signal/30')
  })

  it('reports the unchecking too', () => {
    const onChange = vi.fn()
    render(<Toggle checked onChange={onChange} label="Show closed" aria-label="Show closed" />)
    fireEvent.click(screen.getByRole('switch', { checked: true }))
    expect(onChange).toHaveBeenCalledWith(false)
  })
})
