/** Shared CSS source-text scanning helpers for tests that assert on rule bodies rather than
 *  computed styles (jsdom resolves no cascade, so source text is the only contract a unit test
 *  can hold — see themeTokens.test.ts's `readCss` doc comment).
 *
 *  Extracted because the "find every rule whose selector mentions X" scan was duplicated,
 *  verbatim, across themeTokens.test.ts and MenuButton.test.tsx — and both copies made the same
 *  mistake: `main.indexOf('.overlay-card {')` finds only the FIRST exact-substring match, which
 *  is the dark base rule. The light override is spelled `:is(.overlay-card, .overlay-menu) {`
 *  and never matches that substring, so it was silently unscanned. `leafRules` below instead
 *  walks every brace pair in the file and returns every rule that has no nested `{` of its own
 *  (skipping @layer/@media wrappers, which always contain nested rules), pairing each with its
 *  own selector text — so a caller can filter by "selector mentions .overlay-card" and get ALL
 *  matching rules, base and override alike. */

export interface CssRule {
  /** Raw selector text immediately preceding the rule's opening brace, trimmed. */
  selector: string
  /** Raw declaration text between the rule's braces (not including the braces). */
  body: string
}

/** Every leaf rule in a stylesheet — a rule whose body contains no nested `{` — paired with its
 *  selector text. This does not resolve at-rule scoping (@layer/@media): those wrappers are
 *  descended into rather than returned themselves, since their own "body" contains nested `{`
 *  (an at-rule wrapper is never itself a selector a caller would match on). */
export function leafRules(css: string): CssRule[] {
  const rules: CssRule[] = []
  let selectorStart = 0
  let i = 0
  while (i < css.length) {
    if (css[i] === '{') {
      // Strip block comments before trimming: selectorStart is the character right after the
      // PREVIOUS rule's `}`, so it includes any doc comment sitting between that rule and this
      // one — without stripping, a comment mentioning a class name in prose (e.g. "the menu is
      // `--bg-1`/`--hair`") would corrupt the selector text and break exact-selector matching.
      const selector = css
        .slice(selectorStart, i)
        .replace(/\/\*[\s\S]*?\*\//g, '')
        .trim()
      let depth = 1
      let j = i + 1
      while (j < css.length && depth > 0) {
        if (css[j] === '{') depth++
        else if (css[j] === '}') depth--
        j++
      }
      const close = j - 1
      const body = css.slice(i + 1, close)
      if (body.includes('{')) {
        // A wrapper (@layer, @media, …) — recurse into its body for the real rules.
        rules.push(...leafRules(body))
      } else {
        rules.push({ selector, body })
      }
      i = close + 1
      selectorStart = i
    } else {
      i++
    }
  }
  return rules
}

/** Every leaf rule whose selector text mentions `.overlay-card`, `.overlay-menu`, `.glass-chrome`
 *  or `.glass-card` — the dark base rules AND the
 *  `:is(.overlay-card, .overlay-menu, .glass-chrome, .glass-card)` light override alike.
 *  `.glass-chrome` joined this scan at Task 10 review (finding 2/3); `.glass-card` joined the
 *  shared selector itself at Task 12 (review finding 1) once its own light-side declarations were
 *  no longer duplicated in theme-dynamic.css. Each of the four exists for exactly the same
 *  layout-carrying-properties reason (see main.css's comment above `.overlay-card`), so each
 *  needs the same position/overflow guard, and merging its light recipe into the shared
 *  `:is(...)` selector is what this scan now picks up for free — listing all four conditions
 *  explicitly (rather than relying on one match covering the merged rule) keeps the scan correct
 *  even if a future task ever pulls one of them back out into its own selector. */
export function overlayMaterialRules(css: string): CssRule[] {
  return leafRules(css).filter(
    (r) =>
      r.selector.includes('.overlay-card') ||
      r.selector.includes('.overlay-menu') ||
      r.selector.includes('.glass-chrome') ||
      r.selector.includes('.glass-card')
  )
}
