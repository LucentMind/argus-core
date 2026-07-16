const CITE_RE = /\[((?:evidence\/|findings\.md|\.rca\/)[^\][:]*?):(\d+)\](?!\()/g

export function linkifyCitations(markdown: string): string {
  return markdown.replace(
    CITE_RE,
    (_m, relPath: string, line: string) => `[${relPath}:${line}](cite://${relPath}?line=${line})`
  )
}

export function parseCiteHref(href: string): { relPath: string; line: number } | null {
  if (!href.startsWith('cite://')) return null
  const [p, q] = href.slice('cite://'.length).split('?line=')
  return { relPath: p, line: Number(q ?? 1) }
}

export type CiteSegment =
  { type: 'text'; text: string } | { type: 'cite'; relPath: string; line: number }

/**
 * Split plain text into alternating text / `[relPath:line]` citation segments.
 * Used to make citations clickable in USER messages, which (unlike assistant
 * messages) are rendered as plain text — not through the markdown linkifier.
 */
export function splitCitations(text: string): CiteSegment[] {
  const re = new RegExp(CITE_RE.source, 'g') // fresh instance: CITE_RE is global (stateful lastIndex)
  const out: CiteSegment[] = []
  let last = 0
  let m: RegExpExecArray | null
  while ((m = re.exec(text)) !== null) {
    if (m.index > last) out.push({ type: 'text', text: text.slice(last, m.index) })
    out.push({ type: 'cite', relPath: m[1], line: Number(m[2]) })
    last = m.index + m[0].length
  }
  if (last < text.length) out.push({ type: 'text', text: text.slice(last) })
  return out
}
