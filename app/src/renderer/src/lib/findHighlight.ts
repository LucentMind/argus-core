/**
 * In-text highlighting for chat find, built on the CSS Custom Highlight API: ranges are
 * painted over the already-rendered markdown DOM, so nothing in the React tree changes
 * (no re-parsing of react-markdown, no wrapper elements to break syntax-highlighted code).
 * Styles live in main.css (`::highlight(find-hit)` / `::highlight(find-current)`).
 */

const HIT = 'find-hit'
const CURRENT = 'find-current'

/**
 * Every case-insensitive occurrence of `query` in the rendered text under `root`. Matching
 * runs over the concatenated text nodes, so a hit that spans inline markup ("foo **bar**")
 * is still found.
 */
export function findTextRanges(root: Element, query: string): Range[] {
  const q = query.trim().toLowerCase()
  if (!q) return []
  const nodes: Text[] = []
  const starts: number[] = []
  let full = ''
  const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT)
  for (let n = walker.nextNode(); n; n = walker.nextNode()) {
    nodes.push(n as Text)
    starts.push(full.length)
    full += (n as Text).data
  }
  const hay = full.toLowerCase()
  // toLowerCase can change string length for a few characters (e.g. 'İ'); offsets would then
  // point into the wrong node, so bail out rather than highlight the wrong words.
  if (hay.length !== full.length) return []

  // index of the text node holding the character at absolute offset `pos`
  const nodeAt = (pos: number): number => {
    let lo = 0
    let hi = nodes.length - 1
    while (lo < hi) {
      const mid = (lo + hi + 1) >> 1
      if (starts[mid] <= pos) lo = mid
      else hi = mid - 1
    }
    return lo
  }

  const ranges: Range[] = []
  for (let at = hay.indexOf(q); at !== -1; at = hay.indexOf(q, at + q.length)) {
    const last = at + q.length - 1
    const si = nodeAt(at)
    const ei = nodeAt(last)
    const range = document.createRange()
    range.setStart(nodes[si], at - starts[si])
    range.setEnd(nodes[ei], last + 1 - starts[ei])
    ranges.push(range)
  }
  return ranges
}

/** Paint `all` as ordinary hits and `current` as the active ones. No-op where the API is absent (jsdom). */
export function paintFindHighlights(all: Range[], current: Range[]): void {
  if (typeof CSS === 'undefined' || !CSS.highlights || typeof Highlight === 'undefined') return
  CSS.highlights.set(HIT, new Highlight(...all))
  CSS.highlights.set(CURRENT, new Highlight(...current))
}

export function clearFindHighlights(): void {
  if (typeof CSS === 'undefined' || !CSS.highlights) return
  CSS.highlights.delete(HIT)
  CSS.highlights.delete(CURRENT)
}
