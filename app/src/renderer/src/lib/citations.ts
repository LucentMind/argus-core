const CITE_RE = /\[((?:evidence\/|findings\.md|\.rca\/)[^\][:]*?):(\d+)\](?!\()/g

export function linkifyCitations(markdown: string): string {
  return markdown.replace(CITE_RE, (_m, relPath: string, line: string) =>
    `[${relPath}:${line}](cite://${relPath}?line=${line})`
  )
}

export function parseCiteHref(href: string): { relPath: string; line: number } | null {
  if (!href.startsWith('cite://')) return null
  const [p, q] = href.slice('cite://'.length).split('?line=')
  return { relPath: p, line: Number(q ?? 1) }
}
