// @vitest-environment jsdom
import { render } from '@testing-library/react'
import { describe, it, expect } from 'vitest'
import { Card } from '../ui'

describe('Card glass variant', () => {
  it('default variant renders no glass layers (unchanged existing look)', () => {
    const { container } = render(<Card>content</Card>)
    expect(container.querySelector('.glass-card')).toBeNull()
    expect(container.querySelector('.gc-ring')).toBeNull()
    expect(container.firstElementChild!.className.split(/\s+/).filter(Boolean)).toEqual([
      'rounded-r3',
      'border',
      'border-hair',
      'bg-panel',
      'transition-colors'
    ])
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
