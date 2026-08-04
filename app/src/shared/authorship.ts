/**
 * Authorship recorded in a skill's or reference's frontmatter.
 *
 * Pure string functions only — the impure half (resolving the machine's git identity) lives in
 * main/services/authorship.ts. These are in shared/ because the asset viewer parses the trail
 * out of raw file text the renderer already holds, which is what keeps this feature free of a
 * new IPC channel.
 */
import {
  fmBlock,
  fmField,
  fmList,
  removeFrontmatterKeys,
  withFrontmatter,
  withFrontmatterList
} from './frontmatter'

export type Origin = 'authored' | 'proposal' | 'fork'
export interface Identity {
  name: string
  email: string
}
export interface Contributor {
  name: string
  email: string
  date: string
}
export interface Authorship {
  /** Raw `Name <email>` exactly as written; null when the asset predates authorship. */
  author: string | null
  origin: Origin | null
  contributors: Contributor[]
}

const ORIGINS: readonly string[] = ['authored', 'proposal', 'fork']

/** `Name <email> YYYY-MM-DD` — the name may be empty, the date is required. */
const CONTRIBUTOR_RE = /^(.*?)\s*<([^>]+)>\s+(\d{4}-\d{2}-\d{2})$/

/** Oldest entries roll off past this. `author` is a separate key and survives the trim. */
export const CONTRIBUTOR_CAP = 10

export function formatIdentity(id: Identity): string {
  return `${id.name} <${id.email}>`
}

/** Display half of `Name <email>`; falls back to the address when there is no name. */
export function authorName(author: string | null): string | null {
  if (!author) return null
  const t = author.trim()
  if (!t) return null
  const m = /^(.*?)\s*<([^>]+)>$/.exec(t)
  if (!m) return t
  return m[1].trim() || m[2].trim() || null
}

export function parseAuthorship(raw: string): Authorship {
  const b = fmBlock(raw)
  if (!b) return { author: null, origin: null, contributors: [] }
  const origin = fmField(b.fm, 'origin')
  return {
    author: fmField(b.fm, 'author') || null,
    origin: ORIGINS.includes(origin) ? (origin as Origin) : null,
    contributors: fmList(b.fm, 'contributors').flatMap((line) => {
      const m = CONTRIBUTOR_RE.exec(line)
      return m ? [{ name: m[1].trim(), email: m[2].trim(), date: m[3] }] : []
    })
  }
}

/**
 * Overlay the on-disk `author`, `origin`, and `contributors` onto an incoming buffer.
 *
 * **The file on disk is authoritative for authorship; the buffer never is.** `stampAuthorship`
 * derives everything from the text it is handed, so any caller whose buffer lost the stamp
 * silently reassigns the byline and discards the contributor trail. Three real paths do exactly
 * that: Improve round-trips the whole file through a model, the raw-frontmatter editor lets a
 * user delete the `author:` line, and accepting an edit proposal writes over an asset someone
 * else wrote. Merging first makes `stampAuthorship`'s existing rules (author present ⇒ untouched,
 * contributors upserted) produce the right answer without a special case.
 *
 * A user who edits `author:` by hand is therefore overruled on save — the same treatment
 * `writeReference` already gives a spoofed `trust_tier` (`trust_tier: tier ?? 'user'`, applied
 * even when the disk file carries none). An on-disk key that is simply ABSENT means "nobody yet",
 * not "whatever the buffer says": the incoming buffer's own `author`/`origin`/`contributors` are
 * always stripped before the disk's values (if any) are overlaid, so a currently-unauthored asset
 * cannot be claimed by whatever byline happens to be sitting in the saved buffer.
 *
 * `existing === null` (creating) is the one case where the buffer is all there is, so it returns
 * `incoming` unchanged.
 */
export function mergeAuthorship(incoming: string, existing: string | null): string {
  if (existing === null) return incoming
  const fm = fmBlock(existing)?.fm ?? ''
  const flat: Record<string, string> = {}
  const author = fmField(fm, 'author')
  if (author) flat.author = author
  const origin = fmField(fm, 'origin')
  if (origin) flat.origin = origin
  const contributors = fmList(fm, 'contributors')

  // Strip first, unconditionally — withFrontmatter only ever overlays the keys it's given, it
  // never removes ones it isn't, so an empty `flat` would otherwise leave the buffer's own
  // author/origin lines in place. withFrontmatterList's empty-array case already IS a removal
  // (see below); flat keys need the explicit strip since there is no such built-in.
  // removeFrontmatterKeys goes through splitFm/renderFm rather than a flat-line regex, so it
  // also removes a key an Improve round-trip re-shaped into a block list (e.g. `author:` followed
  // by an indented `- Someone Else <…>` item) without orphaning the indented item.
  let out = removeFrontmatterKeys(incoming, ['author', 'origin'])
  if (Object.keys(flat).length > 0) out = withFrontmatter(out, flat)
  // An empty `contributors` array removes the block outright, so this call is safe unconditionally.
  // This re-serializes the whole frontmatter block via splitFm/renderFm on every save (not only
  // when contributors actually change), which also normalizes any CRLF and drops any blank line
  // inside the block — a wider normalization surface than just the authorship keys.
  return withFrontmatterList(out, 'contributors', contributors)
}

/**
 * Record `identity`'s touch on this asset.
 *
 * `origin: null` means "this write is not authorship" — claim and any other take-ownership
 * action passes it, so the claimer joins the contributor list without the asset asserting that
 * they wrote it. A non-null origin sets author+origin only when there is no author yet; `fork`
 * additionally overwrites origin, which is the sole case where origin is ever rewritten.
 *
 * Dates are day-resolution: the same person stamping twice in one day yields byte-identical
 * output, so repeat saves do not dirty the file or add noise to a HiveMind push diff.
 */
export function stampAuthorship(
  raw: string,
  opts: { identity: Identity | null; origin: Origin | null; now: Date }
): string {
  const { identity, origin, now } = opts
  if (!identity) return raw

  const fm = fmBlock(raw)?.fm ?? ''
  const flat: Record<string, string> = {}
  if (origin !== null) {
    if (!fmField(fm, 'author')) {
      flat.author = formatIdentity(identity)
      flat.origin = origin
    } else if (origin === 'fork') {
      flat.origin = origin
    }
  }

  const entry = `${formatIdentity(identity)} ${now.toISOString().slice(0, 10)}`
  // unparseable lines survive: only an entry whose email matches is replaced. The match is
  // case-insensitive — addresses are, and `J.Han@corp` vs `j.han@corp` would otherwise take
  // two of the ten slots for one person. The entry is rewritten in the identity's own casing.
  const key = identity.email.trim().toLowerCase()
  const kept = fmList(fm, 'contributors').filter((line) => {
    const m = CONTRIBUTOR_RE.exec(line)
    return m === null || m[2].trim().toLowerCase() !== key
  })
  const next = [...kept, entry].slice(-CONTRIBUTOR_CAP)

  const stamped = Object.keys(flat).length > 0 ? withFrontmatter(raw, flat) : raw
  return withFrontmatterList(stamped, 'contributors', next)
}

/**
 * Is `me` demonstrably the only person who has ever touched this asset?
 *
 * Decides how hard the HiveMind share flow looks for an already-open PR. Sole authorship means
 * nobody else's machine can plausibly hold a share PR for this asset, so the local push receipt is
 * a sufficient record and no GitHub round-trip is needed. Anything else — a second contributor, or
 * a byline that is not mine — means a teammate may have one open, and only a live query can say.
 *
 * The rule is a POSITIVE signal — `origin === 'authored'` — not a list of exclusions, because the
 * exclusion list kept leaking. Three separate flows have produced "author: me, one contributor: me,
 * nothing on an exclusion list" for an asset that unmistakably did NOT originate with `me`:
 *   1. `forkSkill` stamps `origin: fork` when it claims an unauthored upstream skill. Closed by
 *      adding `origin === 'fork'` to the blacklist.
 *   2. `claimReference` passes `origin: null` deliberately (claiming is not authoring) but the
 *      claimed file still carries `source_repo`/`source_commit` from `install()`. Closed by adding
 *      that pair to the blacklist.
 *   3. `acceptProposal` stamps `origin: proposal`. A hive skill routinely ships with no `author:`
 *      at all (every core skill does — `install()`'s skill branch stamps nothing into SKILL.md),
 *      so an agent's edit proposal against it finds no existing author, `mergeAuthorship` passes
 *      the body through unchanged, and `stampAuthorship` sets `author: me, origin: proposal,
 *      contributors: [me]` — a shape neither exclusion above catches. Worse for references:
 *      `acceptProposal`'s reference branch merges only author/origin/contributors, so accepting a
 *      proposal against an installed hive reference does not carry `source_repo`/`source_commit`
 *      across at all — it *erases* the one signal exclusion #2 depends on.
 * A fourth leak is only a matter of time under the exclusion-list shape: every new "I merely
 * touched this, I did not write it" origin has to be discovered, reported, and hand-added, and the
 * cost of missing one is silent — the `gh` lookup never runs and a second PR opens on top of a
 * teammate's. Requiring the one origin that means "created from scratch, by me" instead makes an
 * unrecognized or absent origin fail toward the safe query path BY CONSTRUCTION: no future write
 * path can leak sole authorship just by using an origin nobody thought to blacklist yet.
 *
 * Consequence: `origin: null` — an asset predating authorship stamping, or one hand-edited to drop
 * the key — now also routes to the live `gh` query instead of being presumed sole. That trades one
 * extra `gh pr list` call (and a slightly slower share dialog) for closing the hole above; a failed
 * live query still fails OPEN (`state: 'none'` + warning — see `pushStatus`), so this can only ever
 * cost a recoverable duplicate PR, never a wrong block.
 *
 * `source_repo`/`source_commit` stays as a second, independent disqualifier (defence in depth): a
 * file carrying the install stamp came from a hive regardless of what its `origin` field claims, so
 * a stale or hand-edited `origin: authored` cannot resurrect the receipt-only fast path for it.
 *
 * `me === null` (this machine has no usable git identity) returns false, not true: with no identity
 * there is nothing to compare against, so sole authorship is unprovable and the safer, more
 * thorough path is the correct default.
 *
 * Emails compare case-insensitively for the same reason `stampAuthorship` dedupes that way —
 * addresses are case-insensitive, and `J.Han@corp` vs `j.han@corp` is one person.
 */
export function isSoleAuthor(raw: string, me: Identity | null): boolean {
  if (!me) return false
  const key = me.email.trim().toLowerCase()
  const isMe = (entry: string | null): boolean => {
    if (!entry) return false
    const m = /^(.*?)\s*<([^>]+)>$/.exec(entry.trim())
    return m !== null && m[2].trim().toLowerCase() === key
  }
  const { author, origin, contributors } = parseAuthorship(raw)
  const block = fmBlock(raw)
  if (block && (fmField(block.fm, 'source_repo') || fmField(block.fm, 'source_commit')))
    return false
  if (origin !== 'authored') return false
  if (author !== null && !isMe(author)) return false
  if (contributors.length > 1) return false
  return contributors.length === 0 || contributors[0].email.trim().toLowerCase() === key
}
