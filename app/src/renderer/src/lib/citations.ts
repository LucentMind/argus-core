/** Citation grammar: [<path>:<linespec>], where <linespec> is one or more
 *  comma-separated line numbers or `start-end` ranges (e.g. `10`, `5-8`,
 *  `43,56`, `11123-11124,11139`). The path is colon-free but MAY contain spaces
 *  and single-level `[..]` groups — derived-evidence filenames legitimately look
 *  like `evidence/.derived/..._[20210311-015]_PO 512 T ....ESOTrace.zip.txt`.
 *  The path alternation never crosses a stray `[`/`]`, so prose log fragments
 *  such as `[nav-sdk]` or `[IgnoredRoute(...)]` are left alone and, crucially,
 *  cannot swallow a real citation that follows them.
 *  Whether a matched bracket IS a citation is then decided per call:
 *  - static domain: case files (evidence/, findings.md, .rca/)
 *  - dynamic domain: linked workspace repos — the first path segment matches a
 *    repo name supplied by the caller (per case).
 *  Anything else stays plain text. */
const PATH_SUB = String.raw`(?:[^\[\]:]|\[[^\[\]]*\])+`
const LINESPEC_SUB = String.raw`\d+(?:-\d+)?(?:,\s*\d+(?:-\d+)?)*`
const CANDIDATE_RE = new RegExp(String.raw`\[(${PATH_SUB}):(${LINESPEC_SUB})\](?!\()`, 'g')
const STATIC_PREFIX_RE = /^(?:evidence\/|findings\.md|\.rca\/)/

/** What a citation points at, with an inclusive line range (end === start for
 *  single-line citations). */
export interface CiteTarget {
  relPath: string
  start: number
  end: number
}

export type CiteKind = 'evidence' | 'repo'

export function toRepoNameSet(repoNames: readonly string[]): Set<string> {
  return new Set(repoNames.map((n) => n.toLowerCase()))
}

/** 'evidence' = case-file domain; 'repo' = linked workspace code; null = not a
 *  citation. repoNames must be lowercased (use toRepoNameSet). */
export function classifyCitePath(p: string, repoNames: ReadonlySet<string>): CiteKind | null {
  if (STATIC_PREFIX_RE.test(p)) return 'evidence'
  const slash = p.indexOf('/')
  if (slash <= 0) return null
  return repoNames.has(p.slice(0, slash).toLowerCase()) ? 'repo' : null
}

/** Parse a line-spec (`10`, `5-8`, `43,56`, `11123-11124,11139`) into the line
 *  range the citation anchors — start = first line mentioned, end = the largest
 *  line mentioned (so a disjoint list still highlights a sensible span). Returns
 *  null if any token is a reversed range (end < start). */
function parseLineSpec(spec: string): { start: number; end: number } | null {
  let start: number | null = null
  let end = 0
  for (const tok of spec.split(',')) {
    const m = /^\s*(\d+)(?:-(\d+))?\s*$/.exec(tok)
    if (!m) return null
    const s = Number(m[1])
    const e = m[2] === undefined ? s : Number(m[2])
    if (e < s) return null
    if (start === null) start = s
    if (e > end) end = e
  }
  if (start === null) return null
  return { start, end: Math.max(end, start) }
}

export function linkifyCitations(markdown: string, repoNames: readonly string[] = []): string {
  const names = toRepoNameSet(repoNames)
  return markdown.replace(CANDIDATE_RE, (m, p: string, spec: string) => {
    if (classifyCitePath(p, names) === null) return m
    const range = parseLineSpec(spec)
    if (!range) return m
    const label = `${p}:${spec}` // preserve the author's original line-spec
    const endParam = range.end > range.start ? `&end=${range.end}` : ''
    return `[${label}](cite://${p}?line=${range.start}${endParam})`
  })
}

export function parseCiteHref(href: string): CiteTarget | null {
  if (!href.startsWith('cite://')) return null
  const [p, q] = href.slice('cite://'.length).split('?')
  const params = new URLSearchParams(q ?? '')
  const start = Number(params.get('line') ?? 1)
  const rawEnd = Number(params.get('end') ?? start)
  const end = rawEnd >= start ? rawEnd : start
  return { relPath: p, start, end }
}

export type CiteSegment =
  { type: 'text'; text: string } | { type: 'cite'; relPath: string; start: number; end: number }

/**
 * Split plain text into alternating text / citation segments. Used to make
 * citations interactive in USER messages, which (unlike assistant messages)
 * are rendered as plain text — not through the markdown linkifier.
 */
export function splitCitations(text: string, repoNames: readonly string[] = []): CiteSegment[] {
  const names = toRepoNameSet(repoNames)
  const re = new RegExp(CANDIDATE_RE.source, 'g') // fresh instance: global regexes are stateful
  const out: CiteSegment[] = []
  let last = 0
  let m: RegExpExecArray | null
  while ((m = re.exec(text)) !== null) {
    const range = classifyCitePath(m[1], names) !== null ? parseLineSpec(m[2]) : null
    if (!range) continue // not a citation — the bracket stays part of the surrounding text
    if (m.index > last) out.push({ type: 'text', text: text.slice(last, m.index) })
    out.push({ type: 'cite', relPath: m[1], start: range.start, end: range.end })
    last = m.index + m[0].length
  }
  if (last < text.length) out.push({ type: 'text', text: text.slice(last) })
  return out
}
