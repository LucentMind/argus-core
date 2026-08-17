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

/** A YAML block-scalar indicator: `>`/`|` with optional chomping (`-`/`+`). */
const BLOCK_INDICATOR_RE = /^[>|][-+]?$/

/**
 * The `description:` line split into its inline value and, when that value is a block-scalar
 * indicator, the block's body lines. `null` when there is no `description:` key at all.
 *
 * Continuation = any more-indented line, plus blank lines, which YAML treats as paragraph breaks
 * inside a block and not as its end. The block ends at the first non-blank line that is not
 * indented (the next top-level key, a `---` fence, or end of frontmatter). Each line is trimmed,
 * so a `contributors:` block following the description cannot contribute its list items.
 *
 * `[ \t]*`, not `\s*` — `\s` matches newlines too, so an EMPTY description line immediately
 * followed by another key (no blank line between) let `\s*` skip the line break and capture the
 * next key's whole line as the "description". That reordering is exactly what proposals.ts's
 * accept-time `withFrontmatter(body, { name: target })` stamp produces (existing name: line
 * removed, then re-appended after description:), so this is reachable in practice, not just a
 * theoretical edge case. Continuation lines are gathered ONLY after an explicit block indicator,
 * so an empty description still reads as empty rather than absorbing what follows it.
 */
function readDescriptionKey(fm: string): { inline: string; body: string[] } | null {
  const lines = fm.split(/\r?\n/)
  const idx = lines.findIndex((l) => /^description:[ \t]*/.test(l))
  if (idx === -1) return null
  const inline = lines[idx].replace(/^description:[ \t]*/, '').trim()
  const body: string[] = []
  if (BLOCK_INDICATOR_RE.test(inline)) {
    for (let i = idx + 1; i < lines.length; i++) {
      const line = lines[i].trim()
      if (line && !/^[ \t]/.test(lines[i])) break
      body.push(line)
    }
  }
  return { inline, body }
}

/**
 * Parse the `description:` frontmatter tag, supporting both YAML forms:
 *   inline: `description: Use when …`
 *   block:  `description: >` / `>-` / `|` / `|-` followed by more-indented lines
 *
 * A previous implementation was `/^description:[ \t]*(.+)$/m`, which for the block form captured
 * the indicator itself — a description of literally `">"`. Nothing downstream complained, because
 * `validateSkill`'s empty-description error tests falsiness and `">"` is truthy, so a skill
 * written in the folded form shipped with an effectively empty description, unreachable by the
 * trigger-time matching that description exists to drive. Scanning the continuation lines (as
 * `parseRoles` below already does for its own block form) is what fixes it.
 */
export function parseDescription(fm: string | null): string {
  if (!fm) return ''
  const key = readDescriptionKey(fm)
  if (!key) return ''
  if (!BLOCK_INDICATOR_RE.test(key.inline)) return key.inline
  // Both block forms collapse to a single line, literal (`|`) included. A description is
  // rendered as one line everywhere Argus surfaces it, and buildSkillIndex is line-oriented:
  // it emits one `- name: description` bullet per skill and joins them on '\n', so a preserved
  // hard break would inject the description's later lines into that list as bullets belonging
  // to no skill, in every turn's system prompt. Blank lines are paragraph breaks, so they join
  // as a single space rather than doubling one.
  return key.body.filter(Boolean).join(' ').trim()
}

/**
 * True when `description:` opens a block scalar that has no indented body — the shape that
 * reads as an empty description while looking, to whoever wrote the file, like a filled-in one.
 * `validateSkill` uses it to say which fault it found instead of the bare "must not be empty".
 */
export function hasEmptyDescriptionBlock(fm: string | null): boolean {
  if (!fm) return false
  const key = readDescriptionKey(fm)
  // `.some(Boolean)`, not `.length` — the body now carries blank lines, and a block holding
  // nothing but those is still empty. Counting them would fire the untriggerable-skill error
  // at a file whose description is sitting right there under a blank first line.
  return key !== null && BLOCK_INDICATOR_RE.test(key.inline) && !key.body.some(Boolean)
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
