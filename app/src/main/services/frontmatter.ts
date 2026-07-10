/** Minimal YAML-frontmatter helpers (CRLF-safe, same contract as skillsResolver's parser). */

export function fmBlock(raw: string): { fm: string; body: string } | null {
  const m = raw.match(/^---\r?\n([\s\S]*?)\r?\n---\r?\n?/)
  return m ? { fm: m[1], body: raw.slice(m[0].length) } : null
}

export function fmField(fm: string, key: string): string {
  const m = fm.match(new RegExp(`^${key}:\\s*(.+)$`, 'm'))
  return m ? m[1].replace(/\r$/, '').trim() : ''
}

/** Set/override the given keys in the file's frontmatter (creating a block if absent). */
export function withFrontmatter(body: string, entries: Record<string, string>): string {
  const block = fmBlock(body)
  const keep = block
    ? block.fm
        .split(/\r?\n/)
        .filter((l) => !Object.keys(entries).some((k) => l.startsWith(`${k}:`)))
    : []
  const lines = [...keep, ...Object.entries(entries).map(([k, v]) => `${k}: ${v}`)]
  const rest = block ? block.body : body
  return `---\n${lines.join('\n')}\n---\n${rest}`
}
