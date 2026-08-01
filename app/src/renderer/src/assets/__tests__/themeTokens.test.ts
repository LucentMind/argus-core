import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { overlayMaterialRules, leafRules, type CssRule } from './cssRuleScan'

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
  return hit
    ?.slice(name.length + 1)
    .replace(/;$/, '')
    .trim()
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
      '--brand': '#e2f4ff',
      '--scrim': 'rgba(0, 0, 0, 0.6)'
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

describe('backdrop-filter has no -webkit- alias (Task 8 review finding 1)', () => {
  // Lightning CSS (the Tailwind 4 build pipeline) collapses a hand-written
  // `backdrop-filter` / `-webkit-backdrop-filter` alias pair and keeps only the LAST-declared
  // one. Every hand-written rule in this codebase declared the unprefixed property first, so the
  // compiled stylesheet kept only `-webkit-backdrop-filter` — and Blink (Electron's renderer)
  // does not support that prefixed form (`CSS.supports('-webkit-backdrop-filter', ...)` is
  // false in Chromium). Net effect: the blur/saturate never rendered, for `.glass-card`, its
  // `:hover`, `.dyn-case-bar`, or the overlay rules — verified by reordering the two lines,
  // rebuilding, and observing the compiled output kept only whichever came last. Re-adding the
  // `-webkit-` line anywhere silently disables the effect again without any test noticing unless
  // this guard exists — jsdom resolves no cascade and would happily keep both lines forever.
  it('main.css never declares -webkit-backdrop-filter', () => {
    const main = readCss('main.css')
    expect(main).not.toMatch(/-webkit-backdrop-filter/)
  })

  it('theme-dynamic.css never declares -webkit-backdrop-filter', () => {
    const dyn = readCss('theme-dynamic.css')
    expect(dyn).not.toMatch(/-webkit-backdrop-filter/)
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
      expect(
        decl(dark, token),
        `${token} must be declared in theme.css's :root block`
      ).toBeDefined()
    }
  })

  it('the chrome ambient layer stays plain CSS, behind the chrome and above the ground', () => {
    // These two rules are the layering of the case aurora, which now sits behind TopBar. They
    // are hand-written CSS precisely so they cannot be lost to the new-Tailwind-class-under-HMR
    // trap, and the pair only works together: negative z-index without the isolated ancestor
    // puts the canvas under the app's own bg-void, and it disappears entirely.
    expect(decl(block(dyn, '.chrome-ground {'), 'isolation')).toBe('isolate')
    const layer = block(dyn, '.chrome-ambient {')
    expect(decl(layer, 'z-index')).toBe('-1')
    expect(decl(layer, 'top')).toBe('0')
    expect(decl(layer, 'position')).toBe('absolute')
    expect(decl(layer, 'pointer-events')).toBe('none')
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
    // passes vacuously instead of failing (Task 3 review finding 2 — a real, prior version of
    // this style of guard collapsed to '' silently and stayed green).
    const recipeStart = dyn.search(/^\.glass-card \{/m)
    expect(recipeStart, 'the un-scoped .glass-card recipe must be found').toBeGreaterThanOrEqual(0)
    const recipe = dyn.slice(recipeStart)
    const recipeCloseIdx = recipe.indexOf('}')
    expect(recipeCloseIdx, 'the recipe block must close').toBeGreaterThan(0)
    expect(recipe.slice(0, recipeCloseIdx)).not.toContain('animation:')
  })

  it('light keeps the no-brightness-at-rest invariant', () => {
    const lightStart = theme.indexOf(":root[data-theme='light']")
    expect(lightStart, 'the light block selector must be found').toBeGreaterThanOrEqual(0)
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

  it('the un-scoped material recipes carry no hardcoded black literal', () => {
    // .glass-card and .glass-panel are un-scoped — dialogs, chrome and the editor window all
    // need them and none of those live inside .dyn — so a dark-baked black literal in either
    // reaches light surfaces too: 85%-black read as dirt on a #fdfdfe fill (Task 3 review
    // finding 2, caught when .glass-panel's waist line was still the hardcoded
    // `rgba(0, 0, 0, 0.85)` instead of `var(--panel-waist)`).
    //
    // Task 12 split `.glass-card` into a theme-invariant SHAPE rule (position/isolation/
    // overflow/border-width/transition — no paint at all) and a
    // `:where(:root:not([data-theme='light'])) .glass-card` dark-PAINT rule (background/
    // box-shadow, where a reintroduced black literal would actually land). A scan anchored on
    // `^\.glass-card \{` alone finds only the shape rule and never reaches the paint rule — the
    // exact rule this guard exists to protect — so it would pass green even with a fresh
    // `rgba(0, 0, 0, 0.5)` baked into the dark recipe (Task 12 review finding 2). `.glass-panel`
    // has no such split (its one rule is entirely var()-driven, dark and light alike), so this
    // widened scan is a superset of the old one there, not a behaviour change.
    //
    // Reuses cssRuleScan's `leafRules` — the same "find every rule whose selector mentions X"
    // walk `overlayMaterialRules` already relies on for `.overlay-card`/`.overlay-menu`/
    // `.glass-chrome`/`.glass-card` — rather than a second hand-rolled brace walk. Matched by
    // selector identity (stripped of the `:where(...)` dark guard) rather than a substring, so
    // unrelated compound selectors that merely MENTION the class (`.glass-card:hover`,
    // `.dyn-home .glass-card`, `.glass-card > *:not(...)`) are correctly excluded.
    const blackLiteral = /rgba\(0,\s*0,\s*0|#000\b/
    const DARK_GUARD = /^:where\(:root:not\(\[data-theme='light'\]\)\)\s*/

    function paintRules(selector: string): CssRule[] {
      return leafRules(dyn).filter((r) => r.selector.replace(DARK_GUARD, '') === selector)
    }

    const cardRules = paintRules('.glass-card')
    // The shape rule (`.glass-card {`) plus the dark paint rule (`:where(...) .glass-card {`) —
    // a count of exactly 1 would mean the paint rule silently stopped matching (e.g. the
    // `:where(...)` guard text drifted) and this guard fell back to checking only the shape rule.
    expect(
      cardRules.length,
      'expected both the .glass-card shape rule and its dark paint rule'
    ).toBeGreaterThanOrEqual(2)
    for (const r of cardRules) {
      expect(r.body, `.glass-card rule (${r.selector}) must not carry a black literal`).not.toMatch(
        blackLiteral
      )
    }

    const panelRules = paintRules('.glass-panel')
    expect(
      panelRules.length,
      'the un-scoped .glass-panel recipe must be found'
    ).toBeGreaterThanOrEqual(1)
    for (const r of panelRules) {
      expect(
        r.body,
        `.glass-panel rule (${r.selector}) must not carry a black literal`
      ).not.toMatch(blackLiteral)
    }
  })

  it('the .glass-card shape rule pins its own border-width (Task 12 review finding 3)', () => {
    // Light's `.glass-card` gets only `border-color` from main.css's shared frosted selector —
    // the same pattern `.overlay-card`/`.overlay-menu`/`.glass-chrome` use, each leaning on their
    // OWN always-on dark base rule's `border: 1px solid ...` shorthand for width. `.glass-card`'s
    // dark recipe lives in the `:where(:root:not([data-theme='light']))`-scoped paint rule above,
    // which contributes nothing in light, so `border-width` has to come from this un-scoped
    // shape rule instead — drop it and light's border silently falls back to Tailwind preflight's
    // 0px. This exact regression shipped once and was caught only by a manual CDP computed-style
    // probe, never a unit test (jsdom resolves no cascade) — see the comment on this declaration
    // itself. Pinned here so a future "cleanup" reasoning that the dark shorthand makes this
    // redundant fails loudly instead of quietly reintroducing a borderless light card.
    const rules = leafRules(dyn).filter((r) => r.selector === '.glass-card')
    expect(rules.length, 'the un-scoped .glass-card shape rule must be found').toBe(1)
    expect(rules[0].body).toMatch(/(?<![\w-])border-width\s*:/)
  })
})

// Why .overlay-card/.overlay-menu exist instead of `.glass-card` + a `revert-layer` mechanism:
// see the comment above `.overlay-card` in main.css (the nearest-to-the-CSS explanation).
describe('overlay material (dialogs and menus own their own look, not glass-card)', () => {
  const dyn = readCss('theme-dynamic.css')
  const main = readCss('main.css')

  it('theme-dynamic.css no longer references dialogs/menus at all', () => {
    // No `role`-keyed selector, no `revert-layer` — the whole mechanism is deleted, not just
    // disabled, so a future edit can't accidentally resurrect it here.
    expect(dyn).not.toMatch(/revert-layer/)
    expect(dyn).not.toMatch(/\[role=['"]dialog['"]\]/)
    expect(dyn).not.toMatch(/\[role=['"]menu['"]\]/)
  })

  it('.overlay-card, .overlay-menu and .glass-chrome exist in main.css and never declare position/overflow', () => {
    // The defect this rework fixes: `.glass-card` sets `position: relative; overflow: hidden`,
    // unlayered, which out-cascades the dropdown's own `absolute` Tailwind utility and would
    // clip its `left-full` submenu (and, for `.glass-chrome`, TabBar's own "All tabs" dropdown —
    // Task 10's own deviation report). None of the three replacement classes may ever acquire
    // either property — that is the whole point of splitting them out of `.glass-card`.
    //
    // Scans EVERY rule whose selector mentions any of the three classes (via cssRuleScan's
    // leafRules), not just the first exact-substring hit: the light override is spelled
    // `:is(.overlay-card, .overlay-menu, .glass-chrome, .glass-card) { … }` and was silently
    // unscanned by an earlier version of this test that used `main.indexOf('.overlay-card {')`.
    const rules = overlayMaterialRules(main)
    expect(
      rules.length,
      'expected the three dark base rules plus the one shared light override'
    ).toBeGreaterThanOrEqual(4)
    for (const { selector, body } of rules) {
      expect(body, `${selector} must not declare position`).not.toMatch(/(?<![\w-])position\s*:/)
      expect(body, `${selector} must not declare overflow`).not.toMatch(/(?<![\w-])overflow\s*:/)
    }
  })

  it('dark overlay shadow literals are unchanged', () => {
    // These used to come from Tailwind's shadow-2xl / shadow-lg utilities; they are now
    // hand-written literals, so nothing but this pin protects them from drifting under a later
    // tuning pass.
    const rules = overlayMaterialRules(main)
    const card = rules.find((r) => r.selector === '.overlay-card')
    const menu = rules.find((r) => r.selector === '.overlay-menu')
    expect(card, '.overlay-card dark rule must be found').toBeDefined()
    expect(menu, '.overlay-menu dark rule must be found').toBeDefined()

    const shadowValue = (body: string): string | undefined => {
      const m = body.match(/box-shadow\s*:([\s\S]*?);/)
      return m?.[1]
        .replace(/\/\*.*?\*\//g, '')
        .replace(/\s+/g, ' ')
        .trim()
    }

    expect(shadowValue(card!.body)).toBe('0 25px 50px -12px rgb(0 0 0 / 0.25)')
    expect(shadowValue(menu!.body)).toBe(
      '0 10px 15px -3px rgb(0 0 0 / 0.1), 0 4px 6px -4px rgb(0 0 0 / 0.1)'
    )
  })

  // Task 10 review finding 3: `.overlay-card` / `.overlay-menu` had the position/overflow guard
  // above, and `.surface-card` has a layer pin (Card.glass.test.tsx) — but `.glass-chrome` had
  // neither, despite existing for exactly the reason those invariants protect against. Pinned
  // here rather than duplicating Card.glass.test.tsx's walk, using exact-substring anchors (the
  // dark rule's own selector, and the merged light override's selector) rather than a bare
  // `.glass-chrome` substring search, which would also match the class name inside doc comments.
  it('.glass-chrome stays inside @layer components (unlayered would beat the layout utilities)', () => {
    const layerStart = main.indexOf('@layer components {')
    expect(layerStart).toBeGreaterThanOrEqual(0)
    const braceOpen = main.indexOf('{', layerStart)
    let depth = 0
    let layerEnd = -1
    for (let i = braceOpen; i < main.length; i++) {
      if (main[i] === '{') depth++
      else if (main[i] === '}') {
        depth--
        if (depth === 0) {
          layerEnd = i
          break
        }
      }
    }
    expect(layerEnd).toBeGreaterThan(braceOpen)

    const darkIdx = main.indexOf('.glass-chrome {')
    expect(darkIdx, 'the dark .glass-chrome rule must be found').toBeGreaterThanOrEqual(0)
    expect(darkIdx).toBeGreaterThan(braceOpen)
    expect(darkIdx).toBeLessThan(layerEnd)

    const lightSelector = ':is(.overlay-card, .overlay-menu, .glass-chrome, .glass-card) {'
    const lightIdx = main.indexOf(lightSelector)
    expect(lightIdx, 'the merged light override selector must be found').toBeGreaterThanOrEqual(0)
    expect(lightIdx).toBeGreaterThan(braceOpen)
    expect(lightIdx).toBeLessThan(layerEnd)
  })
})
