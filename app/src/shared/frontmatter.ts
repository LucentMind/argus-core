/** Minimal YAML-frontmatter helpers (CRLF-safe, same contract as skillsResolver's parser). */

export function fmBlock(raw: string): { fm: string; body: string } | null {
  const m = raw.match(/^---\r?\n([\s\S]*?)\r?\n---\r?\n?/)
  return m ? { fm: m[1], body: raw.slice(m[0].length) } : null
}

export function fmField(fm: string, key: string): string {
  const m = fm.match(new RegExp(`^${key}:\\s*(.+)$`, 'm'))
  return m ? m[1].replace(/\r$/, '').trim() : ''
}

/**
 * Frontmatter split into flat `key: value` lines and block lists.
 *
 * A list's body is captured as RAW indented lines, never interpreted: `sources:` holds a list
 * of mappings whose continuation lines (`    page_id: "…"`) are indented but do not start with
 * `-`. Ending the run at the first non-`-` line would spill those lines into the flat set and
 * re-emit them above their list, scrambling every Confluence-synced reference. An indented run
 * ends only at a dedent.
 */
interface FmParts {
  flat: string[]
  lists: Array<{ key: string; raw: string[] }>
}

function splitFm(fm: string): FmParts {
  const lines = fm.split(/\r?\n/).map((l) => l.replace(/\r$/, ''))
  const flat: string[] = []
  const lists: Array<{ key: string; raw: string[] }> = []
  for (let i = 0; i < lines.length; i++) {
    const header = lines[i].match(/^([\w-]+):[ \t]*$/)
    if (header && /^[ \t]+\S/.test(lines[i + 1] ?? '')) {
      const raw: string[] = []
      let j = i + 1
      for (; j < lines.length && /^[ \t]+\S/.test(lines[j]); j++) raw.push(lines[j])
      lists.push({ key: header[1], raw })
      i = j - 1
      continue
    }
    if (lines[i].trim()) flat.push(lines[i])
  }
  return { flat, lists }
}

function renderFm(parts: FmParts, rest: string): string {
  const lines = [...parts.flat, ...parts.lists.flatMap((l) => [`${l.key}:`, ...l.raw])]
  return `---\n${lines.join('\n')}\n---\n${rest}`
}

/** Scalar items of a block list — each stripped of its `- ` prefix. Non-list keys yield []. */
export function fmList(fm: string, key: string): string[] {
  const list = splitFm(fm).lists.find((l) => l.key === key)
  if (!list) return []
  return list.raw.flatMap((l) => {
    const m = l.match(/^[ \t]+-[ \t]*(.*)$/)
    return m ? [m[1].trim()] : []
  })
}

/**
 * Set/override the given flat keys in the file's frontmatter (creating a block if absent).
 * Flat keys are emitted first and block lists last, so call order never matters: a later flat
 * write cannot land between a list header and its items.
 */
export function withFrontmatter(body: string, entries: Record<string, string>): string {
  const block = fmBlock(body)
  const parts = block ? splitFm(block.fm) : { flat: [], lists: [] }
  const keys = Object.keys(entries)
  parts.flat = parts.flat.filter((l) => !keys.some((k) => l.startsWith(`${k}:`)))
  // a key written flat can no longer also be a list
  parts.lists = parts.lists.filter((l) => !keys.includes(l.key))
  parts.flat.push(...Object.entries(entries).map(([k, v]) => `${k}: ${v}`))
  return renderFm(parts, block ? block.body : body)
}

/**
 * Remove the given keys' lines outright from a buffer's frontmatter — flat or block-list shape,
 * whichever the key actually has. Unlike `withFrontmatter`, which only ever overlays the keys it
 * is given, this deletes without replacing anything. Going through `splitFm`/`renderFm` (rather
 * than a per-line regex filter) is what keeps a block-list key's indented items from being
 * orphaned: a flat-only filter would drop just the header line, leaving the items behind for
 * `splitFm`'s next pass to reclassify as headerless top-level flat lines.
 */
export function removeFrontmatterKeys(body: string, keys: string[]): string {
  const block = fmBlock(body)
  if (!block) return body
  const parts = splitFm(block.fm)
  parts.flat = parts.flat.filter((l) => !keys.some((k) => l.startsWith(`${k}:`)))
  parts.lists = parts.lists.filter((l) => !keys.includes(l.key))
  return renderFm(parts, block.body)
}

/** Replace (or append) one block list. An empty `items` removes the block entirely. */
export function withFrontmatterList(body: string, key: string, items: string[]): string {
  const block = fmBlock(body)
  const parts = block ? splitFm(block.fm) : { flat: [], lists: [] }
  parts.flat = parts.flat.filter((l) => !l.startsWith(`${key}:`))
  parts.lists = parts.lists.filter((l) => l.key !== key)
  if (items.length > 0) parts.lists.push({ key, raw: items.map((i) => `  - ${i}`) })
  return renderFm(parts, block ? block.body : body)
}
