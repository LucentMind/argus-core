// @vitest-environment jsdom
import { render } from '@testing-library/react'
import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { Card } from '../ui'
import { leafRules } from '../../assets/__tests__/cssRuleScan'

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

  // Task 12 review finding 4: the frosted merge (`.glass-card` joining `.overlay-card`/
  // `.overlay-menu`/`.glass-chrome` in main.css's shared `:is(...)` selector) got a regression
  // test — the selector-match scan above. The SOLID merge (`.surface-card` reading the same
  // `--panel-*` tokens as `.glass-panel`, so the two read identically in light) got none: nothing
  // asserted the light `.surface-card` block avoided a hardcoded colour literal, and nothing
  // asserted `.surface-card` and `.glass-panel` stayed pixel-identical in light. That is the exact
  // invariant Part 1 exists to establish — main.css's own comment above the rule says the two were
  // matching "by construction" (shared tokens) rather than by two hand-copied literal values that
  // could drift apart the moment either was tuned. Without a pin, a future tuning pass to
  // `.glass-panel` could silently re-diverge `.surface-card` with the suite green — the exact bug
  // Part 1 fixed.
  it('light .surface-card matches .glass-panel by construction, not by copied literals', () => {
    const main = readFileSync(join(__dirname, '../../assets/main.css'), 'utf8')
    const dyn = readFileSync(join(__dirname, '../../assets/theme-dynamic.css'), 'utf8')

    const surfaceCardRules = leafRules(main).filter(
      (r) => r.selector === ":root[data-theme='light'] .surface-card"
    )
    expect(surfaceCardRules.length, 'the light .surface-card override must be found').toBe(1)
    const surfaceCardBody = surfaceCardRules[0].body

    // No hardcoded colour literal — every fill/border/shadow value must come from a --panel-*
    // token, not a hand-copied hex/rgb/rgba value that could drift from .glass-panel's own.
    expect(surfaceCardBody).not.toMatch(/#[0-9a-fA-F]{3,8}\b/)
    expect(surfaceCardBody).not.toMatch(/\brgba?\(\s*\d/)
    for (const token of [
      '--panel-border',
      '--panel-bg',
      '--panel-lens-1',
      '--panel-lens-2',
      '--panel-hi',
      '--panel-waist',
      '--panel-shadow'
    ]) {
      expect(surfaceCardBody, `light .surface-card must reference ${token}`).toContain(
        `var(${token})`
      )
    }

    // .glass-panel (theme-dynamic.css) is the un-scoped material both dark and light read — its
    // background/box-shadow are entirely var()-driven already (no light-only override block
    // exists, or needs to), so comparing against its literal declaration text is the cheapest way
    // to assert the two materials paint identically in light, not just similarly.
    const glassPanelRules = leafRules(dyn).filter((r) => r.selector === '.glass-panel')
    expect(glassPanelRules.length, 'the un-scoped .glass-panel recipe must be found').toBe(1)
    const glassPanelBody = glassPanelRules[0].body

    const declValue = (body: string, prop: string): string | undefined =>
      body
        .match(new RegExp(`(?<![\\w-])${prop}\\s*:([\\s\\S]*?);`))?.[1]
        .replace(/\/\*[\s\S]*?\*\//g, '')
        .replace(/\s+/g, ' ')
        .trim()

    for (const prop of ['background', 'box-shadow']) {
      const surfaceValue = declValue(surfaceCardBody, prop)
      const panelValue = declValue(glassPanelBody, prop)
      expect(surfaceValue, `light .surface-card must declare ${prop}`).toBeDefined()
      expect(panelValue, `.glass-panel must declare ${prop}`).toBeDefined()
      expect(surfaceValue, `light .surface-card's ${prop} must match .glass-panel's`).toBe(
        panelValue
      )
    }

    // The border COLOUR must also match (surface-card's light override only changes
    // border-color — width/style stay whatever the dark base rule already set — while
    // glass-panel's is a full `border: 1px solid ...` shorthand, so the two properties aren't
    // byte-identical text, but the colour token inside them must be).
    const borderColor = surfaceCardBody.match(/border-color\s*:\s*([^;]+);/)?.[1].trim()
    const panelBorder = glassPanelBody.match(/\bborder\s*:\s*([^;]+);/)?.[1].trim()
    expect(borderColor, 'light .surface-card must declare border-color').toBeDefined()
    expect(panelBorder, '.glass-panel must declare border').toBeDefined()
    expect(
      panelBorder,
      ".glass-panel's border must carry surface-card's border-color token"
    ).toContain(borderColor)
  })
})
