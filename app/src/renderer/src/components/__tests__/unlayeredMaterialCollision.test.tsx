import { describe, it, expect } from 'vitest'
import { readFileSync, readdirSync } from 'node:fs'
import { join } from 'node:path'

/**
 * `.glass-card` and `.glass-panel` (theme-dynamic.css) are deliberately UNLAYERED CSS — they sit
 * outside `@layer components` so the `dyn-home` ring/sheen overlays, which are absolutely
 * positioned children, can rely on the card establishing a containing block. Unlayered CSS beats
 * every `@layer utilities` declaration regardless of specificity or source order, so both classes'
 * `position: relative` and `overflow: hidden` silently out-cascade any Tailwind positioning
 * utility on the SAME element.
 *
 * That is not theory. It shipped: Task 8 put `.glass-card` on MenuButton's dropdown, whose own
 * `absolute` then lost — the menu computed `position: relative`, stopped overlaying, and pushed
 * the following content down by its own height. Tasks 10 and 12 fixed it by splitting the
 * layout-free `.overlay-card` / `.overlay-menu` / `.glass-chrome` materials out into
 * `@layer components` (see the comment above `.overlay-card` in main.css).
 *
 * `themeTokens.test.ts` guards the other direction — that those three replacement classes never
 * ACQUIRE position/overflow. This guards the direction that has no CSS-side pin: a component
 * putting the unlayered material back onto an element that needs its own positioning.
 *
 * jsdom resolves no cascade and no layers (see the Task 12 computed-style probe), so no render
 * test in this suite can catch this — the class pairing in the source is the contract.
 *
 * KNOWN LIMIT: this sees one element's own class list. `overflow: hidden` clipping a
 * DESCENDANT's absolutely-positioned dropdown (the Task 10 `.glass-chrome` / TabBar case) is the
 * same defect one level down, and a class-list scan cannot see it.
 */
const SRC = join(__dirname, '..', '..')

/**
 * The unlayered materials, and the layout properties each one actually declares — checked against
 * theme-dynamic.css rather than assumed. `.surface-card` / `.overlay-*` / `.glass-chrome` are
 * layered and carry no layout properties at all, so they are absent here by design.
 *
 * The split matters: an earlier draft of this guard applied the overflow rule to both and flagged
 * MermaidBlock's legitimate `glass-panel … overflow-auto` lightbox. `overflow: hidden` occurs
 * exactly once in theme-dynamic.css (line 124, inside `.glass-card`); `.glass-panel` declares
 * position, border, background and box-shadow only. A guard that cries wolf on a correct file
 * gets suppressed, and then it protects nothing.
 */
const POSITION_MATERIALS = ['glass-card', 'glass-panel']
const OVERFLOW_MATERIALS = ['glass-card']

function walk(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((e) => {
    const p = join(dir, e.name)
    if (e.isDirectory()) return e.name === '__tests__' ? [] : walk(p)
    return e.name.endsWith('.tsx') ? [p] : []
  })
}

/**
 * Reads from an opening delimiter to its balanced partner, skipping anything inside a string or
 * template literal. Template bodies are skipped wholesale, so a `${cond ? 'a' : 'b'}` inside one
 * cannot unbalance the count — the raw text is still returned, which is all the class scan needs.
 */
function readBalanced(src: string, open: number, openCh: string, closeCh: string): string {
  let depth = 0
  let quote: string | null = null
  for (let i = open; i < src.length; i++) {
    const c = src[i]
    if (quote) {
      if (c === '\\') i++
      else if (c === quote) quote = null
      continue
    }
    if (c === '"' || c === "'" || c === '`') {
      quote = c
      continue
    }
    if (c === openCh) depth++
    else if (c === closeCh && --depth === 0) return src.slice(open + 1, i)
  }
  return src.slice(open + 1)
}

/** Every `className=` value in a file, whether written as a string or a braced expression. */
export function classNameValues(src: string): string[] {
  const out: string[] = []
  const re = /className\s*=\s*/g
  for (let m = re.exec(src); m; m = re.exec(src)) {
    const start = m.index + m[0].length
    const ch = src[start]
    if (ch === '"' || ch === "'") {
      const end = src.indexOf(ch, start + 1)
      if (end > -1) out.push(src.slice(start + 1, end))
    } else if (ch === '{') {
      out.push(readBalanced(src, start, '{', '}'))
    }
  }
  return out
}

/**
 * Opening JSX tags for one component name, e.g. every `<Card …>`. Needed because the material is
 * not always a literal at the call site: `<Card variant="glass">` applies `.glass-card` from
 * inside ui.tsx, so scanning for the string alone would miss the indirect consumers entirely —
 * CaseCard.tsx, the only one today, among them.
 */
export function openingTags(src: string, name: string): string[] {
  const out: string[] = []
  const re = new RegExp(`<${name}(?=[\\s/>])`, 'g')
  for (let m = re.exec(src); m; m = re.exec(src)) {
    let quote: string | null = null
    let i = m.index
    for (; i < src.length; i++) {
      const c = src[i]
      if (quote) {
        if (c === '\\') i++
        else if (c === quote) quote = null
        continue
      }
      if (c === '"' || c === "'" || c === '`') quote = c
      else if (c === '{') i += readBalanced(src, i, '{', '}').length + 1
      else if (c === '>') break
    }
    out.push(src.slice(m.index, i + 1))
  }
  return out
}

/** A class token, allowing a Tailwind variant prefix (`md:absolute`) and template/quote edges. */
const token = (names: string): RegExp => new RegExp(`(^|[\\s'"\`{}(:])(${names})(?=$|[\\s'"\`{})])`)

/** `position` values that the unlayered `position: relative` would silently defeat. */
const POSITION = token('absolute|fixed|sticky')
/** `overflow` values that the unlayered `overflow: hidden` would silently defeat. */
const OVERFLOW_VISIBLE = token('overflow-(?:x-|y-)?(?:visible|auto|scroll|clip)')

/** `<Card variant="glass">` renders `.glass-card`; every other variant renders `.surface-card`. */
const GLASS_VARIANT = /variant\s*=\s*(?:["']glass["']|\{[^}]*['"]glass['"][^}]*\})/

/**
 * Class lists that carry an unlayered material, from both routes: a literal in a `className`, and
 * a `<Card variant="glass">` whose `className` prop is merged onto the same element in ui.tsx.
 */
export function unlayeredMaterialClassLists(src: string, materials: string[]): string[] {
  const direct = classNameValues(src).filter((v) => materials.some((mat) => token(mat).test(v)))
  // `<Card variant="glass">` renders `.glass-card` specifically, so it only counts for scans that
  // include that material.
  const viaCard = materials.includes('glass-card')
    ? openingTags(src, 'Card')
        .filter((tag) => GLASS_VARIANT.test(tag))
        .flatMap((tag) => classNameValues(tag))
    : []
  return [...direct, ...viaCard]
}

/** Class lists where the unlayered material and a losing utility sit on the SAME element. */
export function collisions(src: string, rule: RegExp, materials: string[]): string[] {
  return unlayeredMaterialClassLists(src, materials).filter((v) => rule.test(v))
}

describe('unlayered material vs. layout utilities', () => {
  // The detector is checked against fixtures BEFORE it is pointed at the repo. A scan whose
  // matcher has quietly stopped matching passes just as green as a clean codebase, and this one
  // is expected to find nothing — so its sensitivity is the only thing separating it from a
  // test that asserts nothing at all.
  describe('the detector itself', () => {
    const pos = (src: string): string[] => collisions(src, POSITION, POSITION_MATERIALS)
    const ovf = (src: string): string[] => collisions(src, OVERFLOW_VISIBLE, OVERFLOW_MATERIALS)

    it('flags the exact markup Task 8 shipped', () => {
      // MenuButton's dropdown as it stood before Task 10, verbatim.
      const shipped = `<div role="menu" className={\`absolute z-30 min-w-44 rounded-r2 glass-card p-1 \${openUp ? 'bottom-full mb-1' : 'mt-1'}\`}>`
      expect(pos(shipped)).toHaveLength(1)
    })

    it('flags a plain string className, a variant-prefixed utility and glass-panel', () => {
      expect(pos('<div className="glass-card absolute" />')).toHaveLength(1)
      expect(pos('<div className="glass-panel md:fixed" />')).toHaveLength(1)
      expect(pos('<div className="sticky glass-panel" />')).toHaveLength(1)
    })

    it('flags the indirect route — <Card variant="glass"> with a positioned className', () => {
      const indirect = `<Card variant="glass" className="absolute top-0 flex flex-col">x</Card>`
      expect(pos(indirect)).toHaveLength(1)
      // …and the ternary spelling CaseCard.tsx actually uses.
      const ternary = `<Card variant={dynamic ? 'glass' : 'default'} className="fixed p-4">x</Card>`
      expect(pos(ternary)).toHaveLength(1)
    })

    it('flags an overflow utility the unlayered `overflow: hidden` would defeat', () => {
      expect(ovf('<div className="glass-card overflow-visible" />')).toHaveLength(1)
      expect(ovf('<div className="glass-card overflow-y-auto" />')).toHaveLength(1)
    })

    it('does not flag the safe pairings', () => {
      // `relative` is what the material already sets — no conflict.
      expect(pos('<Card variant="glass" className="relative p-4">x</Card>')).toEqual([])
      // `overflow-hidden` likewise agrees with the material.
      expect(ovf('<div className="glass-card overflow-hidden" />')).toEqual([])
      // `.glass-panel` declares NO overflow, so a scrolling panel is correct, not a collision.
      // This is MermaidBlock.tsx's lightbox, which the first draft of this guard wrongly flagged.
      expect(ovf('<div className="mermaid-lightbox glass-panel overflow-auto p-4" />')).toEqual([])
      // The layered replacements carry no layout properties, so they may be positioned freely.
      expect(pos('<div className="absolute overlay-menu" />')).toEqual([])
      expect(pos('<div className="fixed overlay-card" />')).toEqual([])
      expect(pos('<div className="absolute glass-chrome" />')).toEqual([])
      expect(pos('<div className="absolute surface-card" />')).toEqual([])
      // A non-glass Card gets `.surface-card`, which is layered.
      expect(pos('<Card className="absolute p-4">x</Card>')).toEqual([])
      // Substrings must not match: `glass-card-header` is not `glass-card`.
      expect(pos('<div className="glass-card-header absolute" />')).toEqual([])
      // A positioned element ELSEWHERE in the same file is not a collision.
      const separate = `<div className="absolute inset-0" /><div className="glass-card p-4" />`
      expect(pos(separate)).toEqual([])
    })
  })

  describe('the repo', () => {
    const files = walk(SRC)

    it('scans a non-empty set of files', () => {
      // A walk that silently covers zero files (a rename, a moved root) passes forever.
      expect(files.length).toBeGreaterThan(50)
      // …and actually reaches the files that carry the material, by both routes: CaseCard.tsx is
      // the only `<Card variant="glass">` consumer today, Composer.tsx a direct `glass-panel` one.
      const names = files
        .filter(
          (f) => unlayeredMaterialClassLists(readFileSync(f, 'utf8'), POSITION_MATERIALS).length
        )
        .map((f) => f.split(/[\\/]/).pop()!)
      expect(names, 'the indirect <Card variant="glass"> route reached no file').toContain(
        'CaseCard.tsx'
      )
      expect(names, 'the direct class-literal route reached no file').toContain('Composer.tsx')
    })

    const scan = (rule: RegExp, materials: string[]): string[] =>
      files.flatMap((f) =>
        collisions(readFileSync(f, 'utf8'), rule, materials).map(
          (v) => `${f.split(/[\\/]/).pop()}: ${v.replace(/\s+/g, ' ').trim()}`
        )
      )

    it('no element carries an unlayered material and a position utility it would lose', () => {
      expect(
        scan(POSITION, POSITION_MATERIALS),
        'glass-card/glass-panel is unlayered — its `position: relative` beats the utility'
      ).toEqual([])
    })

    it('no element carries glass-card and an overflow utility it would lose', () => {
      expect(
        scan(OVERFLOW_VISIBLE, OVERFLOW_MATERIALS),
        'glass-card is unlayered — its `overflow: hidden` beats the utility'
      ).toEqual([])
    })
  })
})
