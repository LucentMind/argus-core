import { z } from 'zod'
import semver from 'semver'
import { isApiCompatible, platformMatchesHost } from './compat'

/** One published bundle. `sha256` covers the zip and is checked before it is ever unzipped. */
export const feedEntrySchema = z.object({
  version: z.string().min(1),
  argusApi: z.string().min(1),
  platform: z.string().regex(/^[a-z0-9]+-[a-z0-9]+$/, 'platform must be <os>-<arch>'),
  url: z.string().url(),
  sha256: z.string().regex(/^[0-9a-f]{64}$/, 'sha256 must be 64 lowercase hex characters')
})
export type FeedEntry = z.infer<typeof feedEntrySchema>

/**
 * A vendor's static update feed. A LIST of versions, deliberately not a `latest` pointer:
 * Core picks the newest entry compatible with *this* build, so a pack that moves to a newer
 * `argusApi` does not strand users on an older Core with an update they can never install.
 */
export const packFeedSchema = z.object({
  id: z.string().min(1),
  versions: z.array(feedEntrySchema)
})
export type PackFeed = z.infer<typeof packFeedSchema>

export interface SelectOptions {
  installedVersion: string
  host?: { platform: string; arch: string }
  /**
   * When given, only entries whose `url` origin equals this are candidates. Without this, the
   * single newest entry could be off-origin and get selected anyway — `apply()`'s origin check
   * would then refuse it and stop, instead of falling back to the next-newest, on-origin entry.
   * Filtering here (rather than only in `apply`) lets a compromised or migrated CDN entry be
   * skipped in favour of an older, still-valid one.
   */
  origin?: string
}

/** `url`'s origin, or `null` if `url` doesn't parse — a malformed entry is excluded, not fatal. */
function originOf(url: string): string | null {
  try {
    return new URL(url).origin
  } catch {
    return null
  }
}

export interface SelectUpdateResult {
  /** The winning entry, or `null` when there is nothing to offer. */
  entry: FeedEntry | null
  /**
   * `true` only when `entry` is `null` AND the reason is specifically that every otherwise-
   * eligible entry (newer, platform-matched, API-compatible) was excluded by the origin filter —
   * i.e. an update genuinely exists, just not from the pinned origin. `false` both when `entry`
   * is non-null and when there is genuinely nothing newer at all, so a caller can tell "the
   * vendor moved off-origin" (should surface as `origin-pin`) apart from "nothing published"
   * (idle) apart from "found one" — three states a single `FeedEntry | null` cannot distinguish.
   * `selectUpdate` stays pure and never throws; it is up to the caller (`findUpdate`) to decide
   * what a `true` here means for its own error reporting.
   */
  excludedByOriginOnly: boolean
}

/**
 * The newest entry that is platform-matched, API-compatible with this Core, strictly newer
 * than what is installed, and (when `origin` is given) hosted on the pinned origin. `entry` is
 * `null` when there is nothing to offer — including when the installed version is not valid
 * semver, since there is then no defensible comparison to make.
 */
export function selectUpdate(feed: PackFeed, opts: SelectOptions): SelectUpdateResult {
  const { installedVersion, host, origin } = opts
  if (semver.valid(installedVersion) == null) return { entry: null, excludedByOriginOnly: false }

  // Computed WITHOUT the origin filter first so a not-null-but-all-off-origin result can be told
  // apart from genuinely nothing being newer — see `SelectUpdateResult.excludedByOriginOnly`.
  const eligible = feed.versions.filter(
    (e) =>
      semver.valid(e.version) != null &&
      semver.gt(e.version, installedVersion) &&
      platformMatchesHost(e.platform, host) &&
      isApiCompatible(e.argusApi)
  )
  const candidates = origin == null ? eligible : eligible.filter((e) => originOf(e.url) === origin)

  if (candidates.length === 0) {
    return { entry: null, excludedByOriginOnly: origin != null && eligible.length > 0 }
  }
  const entry = candidates.reduce((best, e) => (semver.gt(e.version, best.version) ? e : best))
  return { entry, excludedByOriginOnly: false }
}
