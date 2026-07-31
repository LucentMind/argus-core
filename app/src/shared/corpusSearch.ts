import type { AuthoringKind } from './authoringIpc'

/**
 * One row of the editor's asset corpus (spec §6.2's quick open, §6.3's find-references).
 *
 * Assembled in main (`main/services/editorCorpus.ts`) rather than the renderer because
 * `title` lives only in a reference's frontmatter and nothing broadcasts it: `ReferenceStatus`
 * (shared/referenceSync.ts) carries file, tier and author, and stops there.
 */
export interface CorpusItem {
  kind: AuthoringKind
  /** Skill folder name, or reference filename including `.md`. */
  name: string
  /** Frontmatter title. Empty when there is none — the caller falls back to `name`. */
  title: string
  /** Skill frontmatter description. Always empty for references. */
  description: string
  /** `null` for an untagged, hand-authored reference. */
  tier: string | null
}

export interface ReferenceHit {
  kind: AuthoringKind
  /** The asset the mention was found IN, not the asset being searched for. */
  name: string
  /** 1-indexed. */
  line: number
  text: string
}

/** One file may contribute at most this many lines; the panel is a list, not a search engine. */
export const MENTION_CAP = 20
/** A matched line is elided past this, plus a `…`. */
export const MENTION_TEXT_MAX = 200

/**
 * What counts as citing this asset.
 *
 * Spec §6.3: "a corpus scan for the asset's filename and title". A reference is cited both as
 * `jira-fields.md` (the `INDEX.md` link convention, refSync/engine.ts) and as bare `jira-fields`
 * in prose, so both are needles. A skill has no filename to cite — it is a directory — so its
 * name is the only needle. A title that merely restates the stem adds nothing and is dropped, or
 * every reference would scan its own stem twice.
 */
export function needlesFor(item: {
  kind: AuthoringKind
  name: string
  title: string
}): string[] {
  if (item.kind === 'skill') return [item.name]
  const stem = item.name.replace(/\.md$/i, '')
  const out = [item.name, stem]
  const title = item.title.trim()
  if (title && title.toLowerCase() !== stem.toLowerCase() && title.toLowerCase() !== item.name.toLowerCase()) {
    out.push(title)
  }
  return out
}

function escapeRe(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}

/**
 * Lines of `body` that mention any needle.
 *
 * The boundary assertions are the difference between a useful panel and noise: without them
 * every mention of `triage` also matches `triaged`, and a short reference stem matches half the
 * corpus. `[^\w-]` rather than `\b` because a needle routinely ENDS in `.md` — `\b` after `d`
 * would still match inside `jira-fields.mdx`, and a needle can itself contain `-`, which `\b`
 * treats as a boundary.
 */
export function findMentions(
  body: string,
  needles: readonly string[],
  cap: number = MENTION_CAP
): { line: number; text: string }[] {
  if (needles.length === 0) return []
  const re = new RegExp(
    `(?<![\\w-])(?:${needles.map(escapeRe).join('|')})(?![\\w-])`,
    'i'
  )
  const out: { line: number; text: string }[] = []
  // Split on \n and strip a trailing \r rather than splitting on /\r?\n/: the line NUMBERS must
  // stay right on a CRLF file, and a stray \r left in `text` renders as a control character.
  const lines = body.split('\n')
  for (let i = 0; i < lines.length && out.length < cap; i++) {
    const raw = lines[i]!.replace(/\r$/, '')
    if (!re.test(raw)) continue
    const trimmed = raw.trim()
    out.push({
      line: i + 1,
      text:
        trimmed.length > MENTION_TEXT_MAX ? `${trimmed.slice(0, MENTION_TEXT_MAX)}…` : trimmed
    })
  }
  return out
}
