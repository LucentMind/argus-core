/**
 * Spec §6.3, half one: resolve real markdown links.
 *
 * An earlier framing assumed skills cite `references/*.md`. They do not — references are flat
 * files in one shared directory, and the only link convention that actually exists is `INDEX.md`
 * linking siblings as `[Title](name.md)` (refSync/engine.ts's `generateReferencesIndex`). So
 * resolution is deliberately **basename-only against the known reference set**, not real path
 * resolution: it makes `[a](a.md)`, `[a](./a.md)` and `[a](../references/a.md)` all work, and it
 * needs no notion of where the containing file lives — which matters, because a skill lives in
 * its own directory and a reference does not.
 */
export interface MdLink {
  /** Offset of `[` in the document. */
  from: number
  /** Offset one past the closing `)`. */
  to: number
  target: string
}

/**
 * Strips an optional ` "title"` suffix off a raw destination string, returning just the target.
 *
 * Markdown allows `(target "title")`: whitespace, then a double-quoted title, right before the
 * closing paren. We only recognize it in that exact shape — a bare literal search, not a regex,
 * so there is nothing here that can backtrack.
 */
function stripTitle(rawDest: string): string {
  let wsIndex = -1
  for (let p = 0; p < rawDest.length; p++) {
    const c = rawDest.charCodeAt(p)
    if (c === 32 || c === 9) {
      wsIndex = p
      break
    }
  }
  if (wsIndex === -1) return rawDest

  let q = wsIndex
  while (q < rawDest.length) {
    const c = rawDest.charCodeAt(q)
    if (c !== 32 && c !== 9) break
    q++
  }
  if (rawDest[q] !== '"') return rawDest

  const closeQuote = rawDest.indexOf('"', q + 1)
  if (closeQuote === -1) return rawDest

  // Anything after the closing quote must be trailing whitespace only, or this isn't a title.
  for (let r = closeQuote + 1; r < rawDest.length; r++) {
    const c = rawDest.charCodeAt(r)
    if (c !== 32 && c !== 9) return rawDest
  }
  return rawDest.slice(0, wsIndex)
}

/**
 * Hard cap on how many characters of a candidate destination `findDestEnd` will scan looking for
 * the matching `)`. A real link destination is a filename; Windows' own path limit is 260
 * characters, so 2048 is generous headroom while still bounding the worst case per candidate. A
 * destination whose balancing `)` (if any) lies past this many characters is treated as not a
 * link, rather than paying for an unbounded scan — see the quadratic-behind-many-unclosed-parens
 * case in `scanLinks`'s doc comment.
 */
const MAX_DEST_LENGTH = 2048

/**
 * Finds every `[label](target)` construct in `doc` in a single left-to-right pass.
 *
 * This used to be one backtracking regex. A label pattern like `[^\]\n]*` scans to end-of-line
 * looking for a `]` that may not exist, then backtracks through every sub-length it tried, for
 * every `[` in the document — quadratic, and a document with many literal unclosed `[` (informal
 * citations, `[TODO` notes, pasted text) could freeze the editor for seconds. The hand-rolled
 * scanner below never backtracks: every index is visited a bounded number of times.
 *
 * Three things make that true even though it looks like nested loops:
 *  - `nextCloseBracket` (finding the `]` that is followed by `(`) is driven by a cursor, `bp`,
 *    that is shared across every `[` on the current line and only ever moves forward. A run of
 *    unmatched `[` characters makes that cursor scan to end-of-line once, on behalf of the first
 *    `[`; every later `[` on the same line gets an O(1) "already know there's nothing" answer
 *    instead of re-scanning the region we already passed.
 *  - `findDestEnd` (matching the destination's parens) is memoized against the single most
 *    recent `]( ` position. Several `[` in a row can all propose the same `]( ` as their
 *    candidate closing bracket (when none of them individually close first) — without the cache,
 *    each would redo the same paren-depth scan over the same destination text.
 *  - That memo only helps when candidates share a closing bracket. It does nothing when every
 *    `[` has its own distinct, immediately-following `](` and the destination never closes before
 *    end-of-line — e.g. several unfinished draft links on one line, `[a](`, `[b](`, `[c](` — each
 *    `[` then triggers its own fresh scan to `lineEnd`, which is quadratic over such a line.
 *    Two more bounds close that gap: `lastParenOnLine` is computed once per line (as the outer
 *    loop crosses into it) and lets `findDestEnd` reject a candidate in O(1) when there is no `)`
 *    left anywhere on the line to close it; and `MAX_DEST_LENGTH` caps how far any single
 *    candidate scan can run, for the remaining case where `)` characters exist further along the
 *    line but paren depth never returns to zero before them.
 */
export function scanLinks(doc: string): MdLink[] {
  const out: MdLink[] = []
  const len = doc.length

  // State for the current line. Reset every time we cross a newline.
  let lineStart = 0
  let lineEnd = 0
  let bp = 0
  let noMoreClose = false
  let cachedCloseBracket = -1
  let cachedDestEnd = -2
  // Index of the last `)` on the current line, or -1 if the line has none. Computed once per
  // line by a bounded backward scan over [lineStart, lineEnd) only — never past the line's own
  // start — so the total cost across every line is O(document length), not O(document length)
  // repeated per line.
  let lastParenOnLine = -1

  const startNewLine = (from: number): void => {
    const nl = doc.indexOf('\n', from)
    lineStart = from
    lineEnd = nl === -1 ? len : nl
    bp = from
    noMoreClose = false
    cachedCloseBracket = -1
    cachedDestEnd = -2
    lastParenOnLine = -1
    for (let p = lineEnd - 1; p >= lineStart; p--) {
      if (doc.charCodeAt(p) === 41 /* ')' */) {
        lastParenOnLine = p
        break
      }
    }
  }

  // Finds the first index >= `from` (within the current line) where `]` is immediately
  // followed by `(`. `bp` only ever moves forward, and is shared across every caller on this
  // line, so the total work across all calls on one line is bounded by that line's length.
  const nextCloseBracket = (from: number): number => {
    if (noMoreClose) return -1
    if (bp < from) bp = from
    while (bp < lineEnd) {
      if (doc[bp] === ']' && doc[bp + 1] === '(') return bp
      bp++
    }
    noMoreClose = true
    return -1
  }

  // Given the index of a qualifying `]`, finds the index of the matching `)` that closes the
  // `(` two characters later, tracking paren depth so a balanced `(`/`)` pair inside the
  // destination doesn't end it early. Returns -1 if the line ends first (unbalanced), if no `)`
  // remains anywhere on the line to close it, or if the destination runs past MAX_DEST_LENGTH.
  const findDestEnd = (closeBracket: number): number => {
    if (closeBracket === cachedCloseBracket) return cachedDestEnd
    const destStart = closeBracket + 2

    // Mechanism 1: the line's last `)` is already known (computed once when we entered this
    // line). If it falls before where the destination would even start, there is nothing left
    // on the line that could ever close it — reject in O(1) instead of scanning to `lineEnd`.
    if (lastParenOnLine === -1 || lastParenOnLine < destStart) {
      cachedCloseBracket = closeBracket
      cachedDestEnd = -1
      return -1
    }

    // Mechanism 2: even though a `)` exists further along the line, paren depth may never
    // return to zero before it (many stray `(` and few `)`). Cap how far this single scan is
    // allowed to run so that case is bounded too, rather than unbounded by `lineEnd`.
    const scanLimit = Math.min(lineEnd, destStart + MAX_DEST_LENGTH)

    let depth = 1
    let k = destStart
    let result = -1
    while (k < scanLimit) {
      const c = doc[k]
      if (c === '(') depth++
      else if (c === ')') {
        depth--
        if (depth === 0) {
          result = k
          break
        }
      }
      k++
    }
    cachedCloseBracket = closeBracket
    cachedDestEnd = result
    return result
  }

  startNewLine(0)

  let i = 0
  while (i < len) {
    const ch = doc[i]
    if (ch === '\n') {
      i++
      startNewLine(i)
      continue
    }
    // An image (`![...]`) is skipped, not treated as a link.
    if (ch !== '[' || (i > 0 && doc[i - 1] === '!')) {
      i++
      continue
    }

    const closeBracket = nextCloseBracket(i + 1)
    if (closeBracket === -1) {
      // No `]( ` anywhere left on this line — this `[`, and nothing after it on this line,
      // can be a link start.
      i++
      continue
    }

    const destEnd = findDestEnd(closeBracket)
    if (destEnd === -1) {
      // Unbalanced destination parens before end of line: not a link at this position.
      i++
      continue
    }

    const rawDest = doc.slice(closeBracket + 2, destEnd)
    out.push({ from: i, to: destEnd + 1, target: stripTitle(rawDest) })
    i = destEnd + 1
  }

  return out
}

/**
 * The reference this link points at, or `null` when it points nowhere the editor can open.
 *
 * `null` is not an error — it is what earns the subtle underline-warning decoration (§6.3).
 */
export function resolveLink(target: string, known: readonly string[]): string | null {
  // Anchor and query first, so `a.md#x` is a link to `a.md` and a bare `#x` becomes empty.
  const bare = target.split(/[#?]/)[0] ?? ''
  if (bare === '') return null
  // Absolute URLs, protocol-relative URLs and absolute paths are all outside the editor's world.
  if (/^[a-z][a-z0-9+.-]*:/i.test(bare) || bare.startsWith('//') || bare.startsWith('/'))
    return null
  // Split on `/` *before* decoding. A percent-encoded slash (`%2F`) must stay a literal `%2F` in
  // the path segmentation, not decode into a real separator — otherwise `a%2FINDEX.md` would be
  // sliced as if it named `INDEX.md` in a different directory, and the click would open a file
  // the raw markdown never named.
  const rawBase = bare.split('/').pop() ?? ''
  let base: string
  try {
    base = decodeURIComponent(rawBase)
  } catch {
    // A malformed escape is a broken link, not a crash.
    return null
  }
  if (!base.toLowerCase().endsWith('.md')) return null
  const exact = known.find((k) => k === base)
  if (exact) return exact
  // Case-insensitive fallback, returning the KNOWN spelling: reference filenames come off a
  // case-preserving, case-insensitive filesystem on Windows, so `routing.md` in prose and
  // `Routing.md` on disk are the same file and a case-exact match alone would flag it broken.
  // This rests on that same case-insensitive-filesystem assumption for `known` itself: if `known`
  // ever contained two entries differing only in case (which such a filesystem could not actually
  // produce), `find` returns whichever one appears first in `known`, and the result is
  // array-order-dependent.
  const lower = base.toLowerCase()
  return known.find((k) => k.toLowerCase() === lower) ?? null
}
