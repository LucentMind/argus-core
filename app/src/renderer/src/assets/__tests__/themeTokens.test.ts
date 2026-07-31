import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'

const ASSETS = join(__dirname, '..')

/** Read one of the theme stylesheets as source text. jsdom loads no stylesheet and resolves no
 *  cascade, so the CSS source is the only contract a unit test can hold. */
export function readCss(name: string): string {
  return readFileSync(join(ASSETS, name), 'utf8')
}

/** The declarations inside the first `selector { … }` block, as a trimmed list. */
function block(css: string, selector: string): string[] {
  const start = css.indexOf(selector)
  if (start < 0) throw new Error(`selector not found: ${selector}`)
  const open = css.indexOf('{', start)
  const close = css.indexOf('}', open)
  return css
    .slice(open + 1, close)
    .split('\n')
    .map((l) => l.replace(/\/\*.*?\*\//g, '').trim())
    .filter((l) => l.length > 0 && l !== '*/' && !l.startsWith('/*') && !l.startsWith('*'))
}

function decl(lines: string[], name: string): string | undefined {
  const hit = lines.find((l) => l.startsWith(`${name}:`))
  return hit?.slice(name.length + 1).replace(/;$/, '').trim()
}

describe('theme tokens', () => {
  const css = readCss('theme.css')

  // ── the dark pin ────────────────────────────────────────────────────────────
  // The redesign is light-only. This asserts every dark value verbatim so a stray edit to a
  // shared rule cannot silently restyle dark. If a dark token genuinely must change, that is a
  // separate decision and this list is edited deliberately, not incidentally.
  it('dark tokens are unchanged', () => {
    const dark = block(css, ':root {')
    const expected: Record<string, string> = {
      '--void': '#000000',
      '--bg-1': '#0a0a0b',
      '--bg-2': '#111114',
      '--bg-hi': '#17171c',
      '--bg-over': '#1d1d23',
      '--ink': '#efede6',
      '--dim': 'rgba(239, 237, 230, 0.62)',
      '--mute': 'rgba(239, 237, 230, 0.38)',
      '--faint': 'rgba(239, 237, 230, 0.18)',
      '--hair': 'rgba(255, 255, 255, 0.06)',
      '--hair-2': 'rgba(255, 255, 255, 0.1)',
      '--scrollbar-thumb': 'rgba(255, 255, 255, 0.28)',
      '--scrollbar-thumb-hover': 'rgba(255, 255, 255, 0.45)',
      '--signal': '#7ec4ff',
      '--defect': '#f3c352',
      '--review': '#8bdca5',
      '--analytics': '#c2a6fa',
      '--danger': '#f27a6b',
      '--brand': '#e2f4ff'
    }
    for (const [name, value] of Object.entries(expected)) {
      expect(decl(dark, name), `dark ${name}`).toBe(value)
    }
  })

  // The priority rails keep their CLASSIC colours in dark by aliasing existing tokens, so
  // adding them changes nothing that renders today.
  it('dark priority rails alias the existing accent tokens', () => {
    const dark = block(css, ':root {')
    expect(decl(dark, '--p1')).toBe('var(--danger)')
    expect(decl(dark, '--p2')).toBe('var(--defect)')
    expect(decl(dark, '--p3')).toBe('var(--mute)')
  })

  // ── the new light palette ───────────────────────────────────────────────────
  it('light tokens are the cool wash palette', () => {
    const light = block(css, ":root[data-theme='light'] {")
    const expected: Record<string, string> = {
      '--void': '#eef2f9',
      '--bg-1': '#eef2f9',
      '--bg-2': '#ffffff',
      '--bg-hi': 'rgba(255, 255, 255, 0.62)',
      '--bg-over': 'rgba(255, 255, 255, 0.76)',
      '--ink': '#101823',
      '--dim': 'rgba(28, 42, 64, 0.68)',
      '--mute': 'rgba(28, 42, 64, 0.5)',
      '--faint': 'rgba(28, 42, 64, 0.3)',
      '--hair': 'rgba(26, 48, 84, 0.09)',
      '--hair-2': 'rgba(26, 48, 84, 0.15)',
      '--signal': '#1f6fd0',
      '--defect': '#b3760a',
      '--danger': '#c93b3b',
      '--review': '#1e8f5c',
      '--analytics': '#7351c9',
      '--brand': '#3a4c66'
    }
    for (const [name, value] of Object.entries(expected)) {
      expect(decl(light, name), `light ${name}`).toBe(value)
    }
  })

  it('light --void stays opaque — it doubles as the label colour on accent fills', () => {
    const light = block(css, ":root[data-theme='light'] {")
    const value = decl(light, '--void')!
    // Btn variant="primary" is `bg-signal text-void`. A transparent or near-white --void makes
    // that label invisible, and no jsdom test would ever show it.
    expect(value).toMatch(/^#[0-9a-f]{6}$/i)
  })

  it('the warm paper palette is gone', () => {
    const light = block(css, ":root[data-theme='light'] {").join('\n')
    for (const dead of ['#f5f3ee', '#faf8f3', '#f0eee7', '#eae8e1', '#16232e', '#1567b3']) {
      expect(light, `stale warm token ${dead}`).not.toContain(dead)
    }
  })
})

describe('the wash ground', () => {
  const theme = readCss('theme.css')
  const main = readCss('main.css')

  it('--wash is declared in the light block only', () => {
    expect(theme).toMatch(/--wash:/)
    const darkEnd = theme.indexOf(":root[data-theme='light']")
    expect(theme.slice(0, darkEnd)).not.toContain('--wash:')
  })

  it('the ground rule anchors the wash to the viewport', () => {
    // background-attachment: fixed is load-bearing, not decoration: every ground-painting
    // element samples the SAME viewport-anchored gradient, so nested and stacked containers
    // line up into one continuous wash with no new layer and no z-index work.
    expect(main).toMatch(/background-attachment:\s*fixed/)
    expect(main).toMatch(/background-image:\s*var\(--wash\)/)
  })

  it('the ground rule covers body and .bg-void but NOT .bg-deep', () => {
    // bg-deep does two unrelated jobs today: ground in TopBar / PanelTabStrip / the editor
    // root, and CARDS in observability/MetricCards, the Observability range select, and
    // MenuButton's dropdown. Blanketing it would hand those three the page wash as their fill.
    // The sweep splits the two uses at each call site instead.
    //
    // This walks backward from each wash declaration to its enclosing selector (rather than
    // slicing forward from the `--wash` token, which lands mid-declaration and never reaches a
    // selector at all) so the assertion actually inspects selector text.
    const declaration = 'background-image: var(--wash)'
    const selectors: string[] = []
    let searchFrom = 0
    for (;;) {
      const idx = main.indexOf(declaration, searchFrom)
      if (idx < 0) break
      const openBrace = main.lastIndexOf('{', idx)
      const prevCloseBrace = main.lastIndexOf('}', openBrace)
      const preceding = main
        .slice(prevCloseBrace + 1, openBrace)
        .replace(/\/\*[\s\S]*?\*\//g, '')
        .trim()
      selectors.push(preceding)
      searchFrom = idx + declaration.length
    }
    expect(selectors.length).toBeGreaterThan(0)
    const combined = selectors.join(' ')
    expect(combined).toContain('body')
    expect(combined).toContain('.bg-void')
    expect(combined).not.toContain('.bg-deep')
  })
})
