/**
 * Authorship recorded in a skill's or reference's frontmatter.
 *
 * Pure string functions only — the impure half (resolving the machine's git identity) lives in
 * main/services/authorship.ts. These are in shared/ because the asset viewer parses the trail
 * out of raw file text the renderer already holds, which is what keeps this feature free of a
 * new IPC channel.
 */
import { fmBlock, fmField, fmList } from './frontmatter'

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
