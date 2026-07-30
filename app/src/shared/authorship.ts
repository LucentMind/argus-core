/**
 * Authorship recorded in a skill's or reference's frontmatter.
 *
 * Pure string functions only — the impure half (resolving the machine's git identity) lives in
 * main/services/authorship.ts. These are in shared/ because the asset viewer parses the trail
 * out of raw file text the renderer already holds, which is what keeps this feature free of a
 * new IPC channel.
 */
import { fmBlock, fmField, fmList, withFrontmatter, withFrontmatterList } from './frontmatter'

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
 * `writeReference` already gives a spoofed `trust_tier`.
 *
 * `existing` null (creating), or carrying none of the three keys, returns `incoming` unchanged.
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

  let out = Object.keys(flat).length > 0 ? withFrontmatter(incoming, flat) : incoming
  if (contributors.length > 0) out = withFrontmatterList(out, 'contributors', contributors)
  return out
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
