import { describe, it, expect } from 'vitest'
import { readFileSync, readdirSync, statSync } from 'node:fs'
import { join } from 'node:path'

// Guards against the class of bug found in Task 7 review: a hand-typed Tailwind colour
// utility (`bg-over` instead of `bg-overlay`) that emits no CSS. Tailwind only generates a
// utility for names it recognises, so a typo like this renders as a transparent no-op — the
// class string is still present in the DOM, so jsdom-based component tests can't catch it.
// This test derives the valid colour names straight from theme.css's `@theme inline` block
// (so it tracks the tokens, not a hardcoded copy of them) and then greps every component's
// class-like tokens against that set.

const COMPONENTS_ROOT = join(__dirname, '..')
const THEME_CSS_PATH = join(__dirname, '../../assets/theme.css')

/** Step 1: pull every `--color-<name>: ...` declared inside the `@theme inline { ... }` block
 *  of theme.css. These are the only colour names Tailwind will actually generate bg-/text-/
 *  border-/etc. utilities for. */
function readValidThemeColours(): Set<string> {
  const css = readFileSync(THEME_CSS_PATH, 'utf8')
  const blockStart = css.indexOf('@theme inline {')
  expect(blockStart).toBeGreaterThanOrEqual(0)
  const braceOpen = css.indexOf('{', blockStart)
  let depth = 0
  let blockEnd = -1
  for (let i = braceOpen; i < css.length; i++) {
    if (css[i] === '{') depth++
    else if (css[i] === '}') {
      depth--
      if (depth === 0) {
        blockEnd = i
        break
      }
    }
  }
  expect(blockEnd).toBeGreaterThan(braceOpen)
  const block = css.slice(braceOpen + 1, blockEnd)

  const names = new Set<string>()
  const colourDeclRe = /--color-([a-zA-Z0-9-]+)\s*:/g
  let m: RegExpExecArray | null
  while ((m = colourDeclRe.exec(block))) {
    names.add(m[1])
  }
  return names
}

/** Step 2 helper: walk every .tsx under components, skipping __tests__. */
function listComponentFiles(dir: string): string[] {
  const out: string[] = []
  for (const entry of readdirSync(dir)) {
    if (entry === '__tests__') continue
    const p = join(dir, entry)
    const st = statSync(p)
    if (st.isDirectory()) out.push(...listComponentFiles(p))
    else if (entry.endsWith('.tsx')) out.push(p)
  }
  return out
}

/** Strips comments and `style={...}` attribute bodies before scanning for class-like tokens.
 *  Without this, `// ring-buffer eviction` (a comment) and `style={{ background:
 *  \`...var(--bg-2)\` }}` (a raw CSS var reference, not a Tailwind class) both produce false
 *  positives — confirmed empirically by running the scan without this step first. */
function stripCommentsAndStyleAttrs(src: string): string {
  let out = src.replace(/\/\*[\s\S]*?\*\//g, '')
  out = out.replace(/\/\/.*$/gm, '')

  let result = ''
  let i = 0
  for (;;) {
    const idx = out.indexOf('style={', i)
    if (idx === -1) {
      result += out.slice(i)
      break
    }
    result += out.slice(i, idx)
    let depth = 0
    let j = idx + 'style='.length
    for (; j < out.length; j++) {
      if (out[j] === '{') depth++
      else if (out[j] === '}') {
        depth--
        if (depth === 0) {
          j++
          break
        }
      }
    }
    i = j
  }
  return result
}

const CLASS_PREFIXES = ['bg', 'text', 'border', 'ring', 'fill', 'stroke', 'from', 'via', 'to']
const CLASS_TOKEN_RE = new RegExp(`\\b(${CLASS_PREFIXES.join('|')})-([a-zA-Z0-9_.\\-]+)`, 'g')

// ── Allowlist ────────────────────────────────────────────────────────────────────────────
// Built empirically: this test was run once against the whole tree with an empty allowlist
// and every entry below is a token it flagged that is NOT a colour typo. Nothing here was
// guessed in advance.

// Tailwind's own colour keywords — not project theme tokens, legitimately used alongside them
// (e.g. `bg-black/60` scrims, `border-transparent`, `fill-current`).
const BUILTIN_COLOUR_KEYWORDS = new Set(['black', 'white', 'current', 'transparent', 'inherit'])

// Non-colour utilities that happen to share a prefix with a colour utility (sizing, alignment,
// side/width/style modifiers, ring width/offset). Kept as full "prefix-name" tokens rather than
// a loose pattern so this list stays a literal, auditable inventory instead of a silent
// catch-all.
const STRUCTURAL_UTILITIES = new Set([
  // border side / width / style — no colour involved
  'border-b',
  'border-b-0',
  'border-b-2',
  'border-l',
  'border-l-0',
  'border-r',
  'border-t',
  'border-t-0',
  'border-t-2',
  'border-x',
  'border-dashed',
  'border-t-transparent', // side + built-in "transparent" fused into one utility name

  // text sizing / alignment — no colour involved
  'text-xs',
  'text-sm',
  'text-lg',
  'text-2xl',
  'text-base',
  'text-left',
  'text-right',
  'text-center',

  // ring width / offset — no colour, or colour fused with "offset-"
  'ring-1',
  'ring-2',
  'ring-offset-2',
  'ring-offset-void'
])

// Pre-existing bug, NOT introduced by and out of scope for Task 7's fix (which touches only
// ObservabilityView.tsx). `border-line` is not a real utility — there is no `--color-line`
// token, so the border falls back to the browser default instead of the intended `border-hair`.
// Flagged in the Task 7 Finding-2 report; kept here (not silently fixed) so this new guard has
// a green baseline. Remove this entry once that bug is fixed on its own.
const KNOWN_PRE_EXISTING_ISSUES = new Set(['border-line'])

describe('theme colour utility guard', () => {
  it('every bg-/text-/border-/ring-/fill-/stroke-/from-/via-/to- colour token is real', () => {
    const validColours = readValidThemeColours()
    expect(validColours.size).toBeGreaterThan(5) // sanity: parsing actually found tokens

    const files = listComponentFiles(COMPONENTS_ROOT)
    expect(files.length).toBeGreaterThan(20) // sanity: walk actually found the tree

    const failures: string[] = []

    for (const file of files) {
      const raw = readFileSync(file, 'utf8')
      const scanned = stripCommentsAndStyleAttrs(raw)
      let m: RegExpExecArray | null
      CLASS_TOKEN_RE.lastIndex = 0
      while ((m = CLASS_TOKEN_RE.exec(scanned))) {
        const prefix = m[1]
        const rawName = m[2]
        const fullToken = `${prefix}-${rawName}`

        // Arbitrary values (bg-[#fff], text-[10px]) are Tailwind's own escape hatch — they
        // aren't looked up against a token table, so they can't suffer this bug.
        if (rawName.startsWith('[')) continue

        // Strip a trailing opacity modifier (bg-danger/10, bg-void/80) before checking the
        // base colour name.
        const slashIdx = rawName.indexOf('/')
        const baseName =
          slashIdx !== -1 && /^\d+$/.test(rawName.slice(slashIdx + 1))
            ? rawName.slice(0, slashIdx)
            : rawName

        if (validColours.has(baseName)) continue
        if (BUILTIN_COLOUR_KEYWORDS.has(baseName)) continue
        if (STRUCTURAL_UTILITIES.has(fullToken)) continue
        if (KNOWN_PRE_EXISTING_ISSUES.has(fullToken)) continue

        const relPath = file.split(/[/\\]components[/\\]/).pop()
        failures.push(
          `${relPath}: \`${fullToken}\` — "${baseName}" is not a valid theme colour ` +
            `(from theme.css's @theme inline block), a recognised Tailwind built-in, or an ` +
            `allowlisted structural utility. If this is a real colour, check for a typo ` +
            `against --color-${baseName} in theme.css.`
        )
      }
    }

    expect(
      failures,
      `Found ${failures.length} invalid theme-colour utility token(s):\n${failures.join('\n')}`
    ).toEqual([])
  })
})
