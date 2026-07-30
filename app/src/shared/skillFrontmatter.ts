/**
 * Pure frontmatter parsing for skill files.
 *
 * These lived in main/services/agent/skillsResolver.ts. They moved here because the in-app
 * editor's validator runs in BOTH processes and `shared/*` may not import from `main/*` —
 * a copy would let the editor and the resolver disagree about what a file means.
 */

/** The `---`-fenced frontmatter body of a raw file, or null when there is no fence. */
export function frontmatterOf(raw: string): string | null {
  return raw.match(/^---\r?\n([\s\S]*?)\r?\n---/)?.[1] ?? null
}

export function parseDescription(fm: string | null): string {
  if (!fm) return ''
  // [ \t]*, not \s* — \s matches newlines too, so an EMPTY description line immediately
  // followed by another key (no blank line between) let \s* skip the line break and capture
  // the next key's whole line as the "description". That reordering is exactly what
  // proposals.ts's accept-time `withFrontmatter(body, { name: target })` stamp produces
  // (existing name: line removed, then re-appended after description:), so this is reachable
  // in practice, not just a theoretical edge case.
  const m = fm.match(/^description:[ \t]*(.+)$/m)
  return m ? m[1].replace(/\r$/, '').trim() : ''
}

const stripQuotes = (s: string): string => s.trim().replace(/^["']|["']$/g, '')

/**
 * Parse the `roles:` frontmatter tag, supporting both YAML forms:
 *   inline: `roles: [review, triage]` / `roles: review, triage` / `roles: review` /
 *            `roles: "review"` / `roles: []`
 *   block:  `roles:\n  - review\n  - triage`
 *
 * A previous implementation used `/^roles:\s*(.+)$/m`, but `\s` matches newlines too, so for
 * the block form it consumed the line break after `roles:` and `(.+)` captured only the first
 * list item's raw text (`"- review"`) as a single mangled role — silently deranking the skill
 * in every mode. Scanning line-by-line (no `\s*` crossing a newline) avoids that.
 */
export function parseRoles(fm: string | null): string[] {
  if (!fm) return []
  const lines = fm.split(/\r?\n/)
  const idx = lines.findIndex((l) => /^roles:\s*/.test(l))
  if (idx === -1) return []
  const inline = lines[idx].replace(/^roles:\s*/, '').trim()
  if (inline) {
    return inline
      .replace(/^\[|\]$/g, '')
      .split(',')
      .map(stripQuotes)
      .filter(Boolean)
  }
  const items: string[] = []
  for (let i = idx + 1; i < lines.length; i++) {
    const m = lines[i].match(/^\s+-\s*(.+)$/)
    if (!m) break
    items.push(stripQuotes(m[1]))
  }
  return items.filter(Boolean)
}

/** True when a `roles:` key is present at all, regardless of whether it parsed to anything. */
export function hasRolesKey(fm: string | null): boolean {
  return fm !== null && fm.split(/\r?\n/).some((l) => /^roles:\s*/.test(l))
}
