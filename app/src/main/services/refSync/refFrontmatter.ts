import { fmBlock, fmField } from '../frontmatter'

/** One synced Confluence source of a reference file (confluence-pages.md convention + version). */
export interface RefSource {
  url: string
  pageId: string
  version: number
  lastSynced: string
}

/** trust_tier of a reference file; null when there is no frontmatter (treated as hand-authored). */
export function refTier(raw: string): string | null {
  const b = fmBlock(raw)
  if (!b) return null
  return fmField(b.fm, 'trust_tier') || null
}

/** Frontmatter title; null when absent — index generation falls back to the filename. */
export function refTitle(raw: string): string | null {
  const b = fmBlock(raw)
  if (!b) return null
  return fmField(b.fm, 'title') || null
}

export function refBody(raw: string): string {
  const b = fmBlock(raw)
  return b ? b.body : raw
}

export function parseRefSources(raw: string): RefSource[] {
  const b = fmBlock(raw)
  if (!b) return []
  const out: RefSource[] = []
  let inSources = false
  let cur: Partial<RefSource> | null = null
  const flush = (): void => {
    if (cur?.pageId) {
      out.push({
        url: cur.url ?? '',
        pageId: cur.pageId,
        version: cur.version ?? 0,
        lastSynced: cur.lastSynced ?? ''
      })
    }
    cur = null
  }
  const assign = (key: string, rawVal: string): void => {
    const v = rawVal.trim().replace(/^"(.*)"$/, '$1')
    if (!cur) return
    if (key === 'url') cur.url = v
    else if (key === 'page_id') cur.pageId = v
    else if (key === 'version') cur.version = Number(v)
    else if (key === 'last_synced') cur.lastSynced = v
  }
  for (const line of b.fm.split(/\r?\n/)) {
    if (/^sources:\s*$/.test(line)) {
      inSources = true
      continue
    }
    if (!inSources) continue
    const item = line.match(/^\s+-\s+(\w+):\s*(.+)$/)
    const field = line.match(/^\s+(\w+):\s*(.+)$/)
    if (item) {
      flush()
      cur = {}
      assign(item[1], item[2])
    } else if (field && cur) {
      assign(field[1], field[2])
    } else if (line.trim() && !/^\s/.test(line)) {
      flush()
      inSources = false
    }
  }
  flush()
  return out
}

/** Full confluence-tier stamp; strips any prior frontmatter from body first. */
export function stampRefFile(
  body: string,
  opts: { title: string; sources: RefSource[]; now: Date }
): string {
  const fm = [
    '---',
    `title: ${opts.title}`,
    'trust_tier: confluence',
    'sources:',
    ...opts.sources.flatMap((s) => [
      `  - url: ${s.url}`,
      `    page_id: "${s.pageId}"`,
      `    version: ${s.version}`,
      `    last_synced: ${s.lastSynced}`
    ]),
    `last_updated: ${opts.now.toISOString().slice(0, 10)}`,
    '---',
    ''
  ].join('\n')
  return fm + refBody(body)
}
