import semver from 'semver'
import { packFeedSchema, selectByRange } from './feed'
import { listReleaseCandidates, readPackManifest } from './githubFeed'
import { isApiCompatible, platformMatchesHost } from './compat'
import {
  MAX_FEED_BYTES,
  FEED_TIMEOUT_MS,
  MAX_PACK_BUNDLE_BYTES,
  DOWNLOAD_TIMEOUT_MS,
  type HttpClient
} from './packUpdates'
import type { GhClient } from './ghClient'
import type { GhRef } from './githubRef'
import type { DeclaredSource } from './dependencies'

/** Where a resolved candidate's bytes come from. Two shapes because the two transports differ:
 *  a feed gives a URL + expected digest, GitHub gives a release asset fetched through `gh`. */
export type CandidateDownload =
  | { kind: 'url'; url: string; sha256: string }
  | { kind: 'gh-asset'; ref: GhRef; tag: string; assetName: string; size: number; sha256: string }

export interface ResolvedCandidate {
  id: string
  version: string
  download: CandidateDownload
  source: DeclaredSource
  /** Host shown to the user in the plan, e.g. 'github.com/org/argus-packs'. */
  originLabel: string
}

export interface CandidateResolver {
  /** The newest version of `id` satisfying `range` from `source`, or null if there is none. */
  resolve(id: string, range: string, source: DeclaredSource): Promise<ResolvedCandidate | null>
}

export interface CandidateResolverDeps {
  http: HttpClient
  gh: GhClient
  host?: { platform: string; arch: string }
}

export function makeCandidateResolver(deps: CandidateResolverDeps): CandidateResolver {
  return {
    async resolve(id, range, source) {
      return source.kind === 'feed'
        ? resolveFromFeed(deps, id, range, source)
        : resolveFromGithub(deps, id, range, source)
    }
  }
}

async function resolveFromFeed(
  deps: CandidateResolverDeps,
  id: string,
  range: string,
  source: Extract<DeclaredSource, { kind: 'feed' }>
): Promise<ResolvedCandidate | null> {
  const res = await deps.http.get(source.updateUrl, {
    maxBytes: MAX_FEED_BYTES,
    timeoutMs: FEED_TIMEOUT_MS
  })
  const feed = packFeedSchema.parse(JSON.parse(res.body.toString('utf8')))
  // A feed answering for a different pack is a misconfiguration or a substitution attempt; both
  // are refusals, not "no candidate". Silently returning null would report it as "not published".
  if (feed.id !== id) {
    throw new Error(`feed at ${source.updateUrl} publishes '${feed.id}', not '${id}'`)
  }
  const entry = selectByRange(feed, { range, host: deps.host, origin: source.origin })
  if (!entry) return null
  return {
    id,
    version: entry.version,
    download: { kind: 'url', url: entry.url, sha256: entry.sha256 },
    source,
    originLabel: new URL(source.updateUrl).host
  }
}

async function resolveFromGithub(
  deps: CandidateResolverDeps,
  id: string,
  range: string,
  source: Extract<DeclaredSource, { kind: 'github' }>
): Promise<ResolvedCandidate | null> {
  const ref: GhRef = { host: source.host, owner: source.owner, repo: source.repo }
  const candidates = await listReleaseCandidates({ gh: deps.gh, host: deps.host }, ref, id)
  // `listReleaseCandidates` leaves `argusApi` empty — see its comment — so compatibility cannot
  // be judged from it directly. Hydrate lazily, newest-first, stopping at the first release that
  // is both in-range and compatible: paying a manifest read for every release on the repo would
  // make planning proportional to release history instead of to the dependencies being resolved.
  const inRange = candidates
    .filter((c) => semver.valid(c.entry.version) != null)
    .filter((c) => semver.satisfies(c.entry.version, range))
    .filter((c) => platformMatchesHost(c.entry.platform, deps.host))
    .sort((a, b) => semver.rcompare(a.entry.version, b.entry.version))

  const pin = {
    kind: 'github' as const,
    host: source.host,
    owner: source.owner,
    repo: source.repo,
    installedAt: 0
  }
  for (const candidate of inRange) {
    const manifest = await readPackManifest(
      { gh: deps.gh, host: deps.host },
      pin,
      candidate.tag,
      id
    )
    if (!manifest || !isApiCompatible(manifest.argusApi)) continue
    return {
      id,
      version: candidate.entry.version,
      download: {
        kind: 'gh-asset',
        ref,
        tag: candidate.tag,
        assetName: candidate.assetName,
        size: candidate.size,
        sha256: candidate.entry.sha256
      },
      source,
      originLabel: `${source.host}/${source.owner}/${source.repo}`
    }
  }
  return null
}

/** Fetch a resolved candidate's bytes. Feed URLs go through `HttpClient`; GitHub assets through
 *  `gh`, which is the only path that can reach a private repo's asset. */
export async function downloadCandidate(
  candidate: ResolvedCandidate,
  destPath: string,
  gh: GhClient,
  http: HttpClient
): Promise<void> {
  if (candidate.download.kind === 'url') {
    const r = await http.getToFile(candidate.download.url, destPath, {
      maxBytes: MAX_PACK_BUNDLE_BYTES,
      timeoutMs: DOWNLOAD_TIMEOUT_MS
    })
    // Check status before the digest: an empty `sha256` on a non-200 (`getToFile` writes
    // nothing in that case) would otherwise be reported as a "mismatch", hiding the real HTTP
    // failure (a 404, a refused redirect, ...) behind a misleading checksum error.
    if (r.status !== 200) {
      throw new Error(`download failed: HTTP ${r.status}`)
    }
    if (r.sha256 !== candidate.download.sha256) {
      throw new Error(`sha256 mismatch for ${candidate.id} ${candidate.version}`)
    }
    return
  }
  const { ref, tag, assetName, size, sha256 } = candidate.download
  if (size > MAX_PACK_BUNDLE_BYTES) {
    throw new Error(`asset is ${size} bytes, over the ${MAX_PACK_BUNDLE_BYTES} byte limit`)
  }
  const result = await gh.downloadAsset(ref, tag, assetName, destPath)
  if (result.sha256 !== sha256) {
    throw new Error(`sha256 mismatch for ${candidate.id} ${candidate.version}`)
  }
  // The pre-download check above only trusts the size the API advertised. The file has already
  // been hashed by `downloadAsset` (see `hashFile`), so this check is free and catches an asset
  // that grew between the API's listing and the actual download.
  if (result.bytesWritten > MAX_PACK_BUNDLE_BYTES) {
    throw new Error(
      `asset is ${result.bytesWritten} bytes, over the ${MAX_PACK_BUNDLE_BYTES} byte limit`
    )
  }
}
