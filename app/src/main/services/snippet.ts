/** Snippet rendering for a contentless FTS index.
 *
 *  `snippet()` cannot be used once evidence_index stores no content — on a contentless
 *  table it returns NULL rather than raising — so the marked-up excerpt is produced here
 *  from text read back off disk. Pure by design: no DB handle, no fs, so it is testable
 *  without either and callable from both the search path and any future consumer.
 */

/** Marker pair, matching what searchEvidence's SQL `snippet()` call used to emit. */
const OPEN = '«'
const CLOSE = '»'

export const SNIPPET_MAX_CHARS = 240

/** Query terms, lowercased. Mirrors findMatchLine's tokenisation so the highlighted
 *  span and the deep-linked line are derived from the same notion of "a term". */
export function queryTerms(query: string): string[] {
  return query.trim().toLowerCase().split(/\s+/).filter(Boolean)
}

/** Non-overlapping, ascending match ranges for every term. Overlapping hits are merged
 *  rather than nested: highlighting 'abc' and 'bcd' in 'abcdef' must produce «abcd», not
 *  a marker inside a marker. */
function matchRanges(text: string, terms: string[]): [number, number][] {
  const hay = text.toLowerCase()
  const ranges: [number, number][] = []
  for (const term of terms) {
    let i = hay.indexOf(term)
    while (i !== -1) {
      ranges.push([i, i + term.length])
      i = hay.indexOf(term, i + term.length)
    }
  }
  if (ranges.length === 0) return ranges
  ranges.sort((a, b) => a[0] - b[0])
  const merged: [number, number][] = [ranges[0]]
  for (const r of ranges.slice(1)) {
    const last = merged[merged.length - 1]
    if (r[0] <= last[1]) last[1] = Math.max(last[1], r[1])
    else merged.push(r)
  }
  return merged
}

function markUp(text: string, ranges: [number, number][]): string {
  let out = ''
  let cursor = 0
  for (const [a, b] of ranges) {
    out += text.slice(cursor, a) + OPEN + text.slice(a, b) + CLOSE
    cursor = b
  }
  return out + text.slice(cursor)
}

/**
 * A `maxChars` window of `text` centred on its first query match, with every match
 * marked up and elisions marked with an ellipsis.
 *
 * With no match (the chunk matched on a term the window read back does not contain —
 * possible if the file changed since indexing) this degrades to the head of the text
 * rather than returning nothing: an unmarked excerpt is still useful, an empty one is
 * indistinguishable from the NULL this function exists to avoid.
 */
export function renderSnippet(text: string, query: string, maxChars = SNIPPET_MAX_CHARS): string {
  if (text === '') return ''
  const terms = queryTerms(query)
  const all = terms.length === 0 ? [] : matchRanges(text, terms)
  if (all.length === 0) {
    return text.length <= maxChars ? text : text.slice(0, maxChars) + '…'
  }
  // Lead with a third of the window before the first match so the match has context on
  // both sides rather than sitting flush against the left edge.
  const start = Math.max(0, all[0][0] - Math.floor(maxChars / 3))
  const end = Math.min(text.length, start + maxChars)
  const window = text.slice(start, end)
  const local = matchRanges(window, terms)
  return (start > 0 ? '…' : '') + markUp(window, local) + (end < text.length ? '…' : '')
}
