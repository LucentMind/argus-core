/** Citation grammar: [<path>:<linespec>], where <linespec> is one or more comma-separated
 *  line numbers or `start-end` ranges (e.g. `10`, `5-8`, `43,56`). The path is colon-free but
 *  MAY contain spaces and single-level `[..]` groups — derived-evidence filenames legitimately
 *  look like `evidence/.derived/..._[20210311-015]_PO 512 T ....ESOTrace.zip.txt`. The path
 *  alternation never crosses a stray `[`/`]`, so prose fragments such as `[nav-sdk]` are left
 *  alone and cannot swallow a real citation that follows them.
 *
 *  Lives in shared/ because both the renderer (link rendering) and main (the finding diff
 *  anchor) need it, and shared/ may not import from either. */
const PATH_SUB = String.raw`(?:[^\[\]:]|\[[^\[\]]*\])+`
const LINESPEC_SUB = String.raw`\d+(?:-\d+)?(?:,\s*\d+(?:-\d+)?)*`

/** A FRESH regex per call: the `g` flag carries `lastIndex`, so a shared instance would skip
 *  matches depending on who scanned last. */
export function makeCitationRe(): RegExp {
  return new RegExp(String.raw`\[(${PATH_SUB}):(${LINESPEC_SUB})\](?!\()`, 'g')
}

/** The first citation in `md`, anchored at the first line it names. Null when there is none.
 *  Used at finding-write time so Plan 4 can post an inline PR comment without re-parsing prose
 *  at the moment it writes to someone's pull request. */
export function firstCitation(md: string): { path: string; line: number } | null {
  const m = makeCitationRe().exec(md)
  if (!m) return null
  const line = Number(m[2].split(',')[0].split('-')[0])
  return Number.isFinite(line) ? { path: m[1], line } : null
}
