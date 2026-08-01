// @vitest-environment jsdom
import { render } from '@testing-library/react'
import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
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

  // jsdom implements no CSS Cascade Layers at all, so it cannot tell us whether hover works —
  // it will not even fail loudly, it just doesn't model the mechanism. Unlayered plain CSS
  // unconditionally outranks every @layer rule regardless of specificity or :hover, so if
  // .surface-card ever leaks back out of @layer components, it silently kills the
  // hover:border-hair2 / hover:bg-hi feedback on every interactive default-variant Card (e.g.
  // CaseCard) while every jsdom-based test stays green. A source-text assertion is the only
  // automated defence available.
  it('.surface-card stays inside @layer components (unlayered would beat the hover utilities)', () => {
    const css = readFileSync(join(__dirname, '../../assets/main.css'), 'utf8')
    const layerStart = css.indexOf('@layer components {')
    expect(layerStart).toBeGreaterThanOrEqual(0)
    const braceOpen = css.indexOf('{', layerStart)
    // Walk forward from the layer's opening brace, counting nested braces, to find the one
    // that actually closes @layer components — not just the next stray '}'.
    let depth = 0
    let layerEnd = -1
    for (let i = braceOpen; i < css.length; i++) {
      if (css[i] === '{') depth++
      else if (css[i] === '}') {
        depth--
        if (depth === 0) {
          layerEnd = i
          break
        }
      }
    }
    expect(layerEnd).toBeGreaterThan(braceOpen)

    // Both the base rule and the light-theme override must be inside the layer — neither may
    // sit unlayered outside it.
    let searchFrom = 0
    let matchCount = 0
    for (;;) {
      const idx = css.indexOf('.surface-card {', searchFrom)
      if (idx === -1) break
      matchCount++
      expect(idx).toBeGreaterThan(braceOpen)
      expect(idx).toBeLessThan(layerEnd)
      searchFrom = idx + 1
    }
    expect(matchCount).toBe(2)
  })
})
