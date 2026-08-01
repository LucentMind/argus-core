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

  // Task 3 relocated the dark material tokens from theme-dynamic.css's .dyn block into this
  // :root block, byte-identical. Pin them here too: this is the exact moment they land in a file
  // Tasks 4-10 will keep editing, and without this pin a one-line edit to any of them would ship
  // green.
  it('the relocated dark material tokens are unchanged', () => {
    const dark = block(css, ':root {')
    const expected: Record<string, string> = {
      '--glass-bg': 'rgba(15, 17, 21, 0.34)',
      '--glass-lens-1': 'rgba(255, 255, 255, 0.145)',
      '--glass-lens-2': 'rgba(255, 255, 255, 0.05)',
      '--glass-lens-3': 'rgba(255, 255, 255, 0.018)',
      '--glass-lens-4': 'rgba(255, 255, 255, 0.055)',
      '--glass-lens-5': 'rgba(255, 255, 255, 0.105)',
      '--glass-cap': 'rgba(190, 220, 255, 0.1)',
      '--glass-border': 'rgba(255, 255, 255, 0.16)',
      '--glass-border-h': 'rgba(255, 255, 255, 0.26)',
      '--glass-hi': 'rgba(255, 255, 255, 0.3)',
      '--glass-hi-h': 'rgba(255, 255, 255, 0.44)',
      '--glass-edge': 'rgba(255, 255, 255, 0.1)',
      '--glass-edge-h': 'rgba(255, 255, 255, 0.16)',
      '--card-shadow': '0 26px 52px -30px rgba(0, 0, 0, 0.98)',
      '--card-shadow-h': '0 40px 72px -32px #000',
      '--glass-filter': 'blur(40px) saturate(200%) brightness(1.08)',
      '--glass-filter-h': 'blur(54px) saturate(230%) brightness(1.13)',
      '--cursor-ring': 'rgba(175, 220, 255, 0.95)',
      '--cursor-ring-2': 'rgba(255, 255, 255, 0.26)',
      '--cursor-sheen': 'rgba(205, 230, 255, 0.16)',
      '--cursor-sheen-2': 'rgba(190, 220, 255, 0.055)',
      '--grain-op': '0.035',
      '--panel-bg': '#090b0e',
      '--panel-lens-1': 'rgba(255, 255, 255, 0.055)',
      '--panel-lens-2': 'rgba(255, 255, 255, 0.016)',
      '--panel-shadow': '0 18px 40px -30px rgba(0, 0, 0, 0.9)',
      '--panel-border': 'rgba(255, 255, 255, 0.085)',
      '--panel-hi': 'rgba(255, 255, 255, 0.11)',
      '--panel-waist': 'rgba(0, 0, 0, 0.85)'
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

describe('material scoping', () => {
  const dyn = readCss('theme-dynamic.css')
  const theme = readCss('theme.css')

  it('the material tokens live in theme.css so classic and the editor resolve them', () => {
    // Scoped to the dark :root block specifically: the requirement is that classic (dark) and
    // the editor window can resolve these, not merely that the token string appears somewhere in
    // the file (it would also appear in the light block alone, or nowhere near :root).
    const dark = block(theme, ':root {')
    for (const token of ['--glass-bg', '--glass-border', '--card-shadow', '--panel-bg']) {
      expect(decl(dark, token), `${token} must be declared in theme.css's :root block`).toBeDefined()
    }
  })

  it('the material recipes are un-scoped', () => {
    // The recipe must not be prefixed — dialogs, chrome and the editor window all live outside
    // any .dyn scope and still need it.
    expect(dyn).toMatch(/^\.glass-card \{/m)
    expect(dyn).toMatch(/^\.glass-panel \{/m)
  })

  it('the home-only behaviour keeps its scope', () => {
    // The entrance animation and the cursor-tracked ring/sheen are home's, not the material's.
    // Dialogs and the editor must not inherit them.
    expect(dyn).toMatch(/\.dyn-home \.glass-card \.gc-ring/)
    expect(dyn).toMatch(/\.dyn-home \.glass-card \.gc-sheen/)
    // Assert on the keyframe name, not just the presence of an `animation:` declaration — the
    // reduced-motion rule below (`.dyn-home .glass-card { animation: none; }`) also matches a
    // bare `animation:` check, so deleting the real entrance-animation rule would leave a
    // weaker assertion green.
    expect(dyn).toMatch(/\.dyn-home \.glass-card \{[^}]*animation:\s*dyn-card-in/)
    // …and the un-scoped recipe must NOT carry them.
    // Guard the two indexOf/search results before slicing: if the selector regex ever stops
    // matching, an unguarded slice(-1) collapses `recipe` to '' and the .not.toContain below
    // passes vacuously instead of failing — the same silent-pass shape as the --surface-* guard
    // below (Task 3 review finding 2).
    const recipeStart = dyn.search(/^\.glass-card \{/m)
    expect(recipeStart, 'the un-scoped .glass-card recipe must be found').toBeGreaterThanOrEqual(
      0
    )
    const recipe = dyn.slice(recipeStart)
    const recipeCloseIdx = recipe.indexOf('}')
    expect(recipeCloseIdx, 'the recipe block must close').toBeGreaterThan(0)
    expect(recipe.slice(0, recipeCloseIdx)).not.toContain('animation:')
  })

  it('light keeps the no-brightness-at-rest invariant', () => {
    const lightStart = theme.indexOf(":root[data-theme='light']")
    expect(lightStart, "the light block selector must be found").toBeGreaterThanOrEqual(0)
    const light = theme.slice(lightStart)
    const filter = light.match(/--glass-filter:\s*([^;]+);/)?.[1]
    expect(filter, '--glass-filter must be declared in the light block').toBeDefined()
    expect(filter).not.toContain('brightness')
  })

  // Pins the guard itself, not just the token values inside it: without
  // `:root:not([data-theme='light'])`, a bare `.dyn { ... }` directly matches — beating the
  // inherited light palette, since a directly-matching declaration wins over an inherited one —
  // and light+dynamic users get a black page with unreadable text. This exact regression shipped
  // once and was reintroduced by a reviewer reverting the selector with the suite still green;
  // Tasks 5-10 keep editing this file, so a future reformat or re-derivation of this block must
  // not be able to drop the guard silently.
  it('the dark .dyn block stays guarded against the light theme', () => {
    expect(dyn).toMatch(/:root:not\(\[data-theme='light'\]\) \.dyn \{/)
    expect(dyn).not.toMatch(/^\.dyn \{/m)
  })

  it('--surface-* is not overridden inside .dyn', () => {
    // .surface-card must stay byte-identical in dyn dark AND dyn light. Overriding --surface-*
    // under either .dyn block would darken (or otherwise restyle) every default Card inside the
    // dynamic scope. Covers both the dark block (guarded by :not([data-theme='light'])) and the
    // light block, not just the dark one.
    //
    // Routed through the shared `block()` helper (not a raw indexOf/slice) deliberately: block()
    // throws if the selector isn't found, so a selector that drifts under Tasks 5-10 fails loudly
    // instead of collapsing both slices to '' and passing vacuously (Task 3 review finding 2 —
    // demonstrated live: reverting the guard AND adding `--surface-bg: red;` inside the dark
    // block left the old indexOf-based version at 14 passed).
    const darkBlock = block(dyn, ":root:not([data-theme='light']) .dyn {").join('\n')
    const lightBlock = block(dyn, ":root[data-theme='light'] .dyn {").join('\n')
    expect(darkBlock).not.toContain('--surface-')
    expect(lightBlock).not.toContain('--surface-')
  })
})
