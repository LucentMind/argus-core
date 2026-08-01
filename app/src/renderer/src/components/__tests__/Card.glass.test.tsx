// @vitest-environment jsdom
import { render } from '@testing-library/react'
import { describe, it, expect } from 'vitest'
import { Card } from '../ui'

describe('Card glass variant', () => {
  it('default variant carries the shared material, not a raw bg utility', () => {
    const { container } = render(<Card>content</Card>)
    expect(container.querySelector('.glass-card')).toBeNull()
    expect(container.querySelector('.gc-ring')).toBeNull()
    expect(container.firstElementChild!.className.split(/\s+/).filter(Boolean)).toEqual([
      'rounded-r3',
      'surface-card',
      'transition-colors'
    ])
  })

  it('default variant no longer paints its own background utility', () => {
    // .surface-card OWNS fill/border/shadow. Leaving bg-panel and border-hair in the class
    // string too would make stylesheet order — not intent — decide the winner, which is the
    // append trap this repo has already been bitten by.
    const { container } = render(<Card>content</Card>)
    const cls = container.firstElementChild!.className
    expect(cls).not.toContain('bg-panel')
    expect(cls).not.toContain('border-hair')
  })

  it('glass variant renders ring + sheen layers and the glass class', () => {
    const { container } = render(
      <Card variant="glass" style={{ '--d': '90ms' } as React.CSSProperties}>
        content
      </Card>
    )
    const root = container.firstElementChild as HTMLElement
    expect(root.className).toContain('glass-card')
    expect(root.className).not.toContain('bg-panel')
    expect(root.querySelector('.gc-ring')).not.toBeNull()
    expect(root.querySelector('.gc-sheen')).not.toBeNull()
    expect(root.style.getPropertyValue('--d')).toBe('90ms')
  })

  it('glass variant keeps the pointer affordance with onClick', () => {
    const { container } = render(
      <Card variant="glass" onClick={() => undefined}>
        x
      </Card>
    )
    expect((container.firstElementChild as HTMLElement).className).toContain('cursor-pointer')
  })

  it('glass variant without onClick has no pointer affordance', () => {
    const { container } = render(<Card variant="glass">x</Card>)
    expect((container.firstElementChild as HTMLElement).className).not.toContain('cursor-pointer')
  })
})
