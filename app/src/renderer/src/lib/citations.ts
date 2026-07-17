/** Citation grammar: [<path>:<start>] or [<path>:<start>-<end>], path free of
 *  brackets/colons. Whether a bracket IS a citation is decided per call:
 *  - static domain: case files (evidence/, findings.md, .rca/)
 *  - dynamic domain: linked workspace repos — the first path segment matches a
 *    repo name supplied by the caller (per case).
 *  Anything else stays plain text. */
const CANDIDATE_RE = /\[([^\][:]+):(\d+)(?:-(\d+))?\](?!\()/g
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

function parseRange(s: string, e: string | undefined): { start: number; end: number } | null {
  const start = Number(s)
  const end = e === undefined ? start : Number(e)
  if (end < start) return null
  return { start, end }
}

export function linkifyCitations(markdown: string, repoNames: readonly string[] = []): string {
  const names = toRepoNameSet(repoNames)
  return markdown.replace(CANDIDATE_RE, (m, p: string, s: string, e?: string) => {
    if (classifyCitePath(p, names) === null) return m
    const range = parseRange(s, e)
    if (!range) return m
    const label = e === undefined ? `${p}:${s}` : `${p}:${s}-${e}`
    const endParam = range.end > range.start ? `&end=${range.end}` : ''
    return `[${label}](cite://${p}?line=${range.start}${endParam})`
  })
}

export function parseCiteHref(href: string): (CiteTarget & { line: number }) | null {
  if (!href.startsWith('cite://')) return null
  const [p, q] = href.slice('cite://'.length).split('?')
  const params = new URLSearchParams(q ?? '')
  const start = Number(params.get('line') ?? 1)
  const rawEnd = Number(params.get('end') ?? start)
  const end = rawEnd >= start ? rawEnd : start
  return { relPath: p, start, end, line: start }
}

export type CiteSegment =
  | { type: 'text'; text: string }
  | { type: 'cite'; relPath: string; line: number; start: number; end: number }

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
    const range = classifyCitePath(m[1], names) !== null ? parseRange(m[2], m[3]) : null
    if (!range) continue // not a citation — the bracket stays part of the surrounding text
    if (m.index > last) out.push({ type: 'text', text: text.slice(last, m.index) })
    out.push({ type: 'cite', relPath: m[1], line: range.start, start: range.start, end: range.end })
    last = m.index + m[0].length
  }
  if (last < text.length) out.push({ type: 'text', text: text.slice(last) })
  return out
}
