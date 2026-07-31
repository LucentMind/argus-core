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
}

/**
 * The newest entry that is platform-matched, API-compatible with this Core, and strictly newer
 * than what is installed. `null` when there is nothing to offer — including when the installed
 * version is not valid semver, since there is then no defensible comparison to make.
 */
export function selectUpdate(feed: PackFeed, opts: SelectOptions): FeedEntry | null {
  const { installedVersion, host } = opts
  if (semver.valid(installedVersion) == null) return null

  const candidates = feed.versions.filter(
    (e) =>
      semver.valid(e.version) != null &&
      semver.gt(e.version, installedVersion) &&
      platformMatchesHost(e.platform, host) &&
      isApiCompatible(e.argusApi)
  )
  if (candidates.length === 0) return null
  return candidates.reduce((best, e) => (semver.gt(e.version, best.version) ? e : best))
}
