import semver from 'semver'
import { packFeedSchema, selectByRange } from './feed'
import { listReleaseCandidates } from './githubFeed'
import { isApiCompatible, platformMatchesHost } from './compat'
import { MAX_FEED_BYTES, FEED_TIMEOUT_MS, type HttpClient } from './packUpdates'
import type { GhClient } from './ghClient'
import type { GhRef } from './githubRef'
import type { DeclaredSource } from './dependencies'

/** Where a resolved candidate's bytes come from. Two shapes because the two transports differ:
 *  a feed gives a URL + expected digest, GitHub gives a release asset fetched through `gh`. */
export type CandidateDownload =
  | { kind: 'url'; url: string; sha256: string }
  | { kind: 'gh-asset'; ref: GhRef; tag: string; assetName: string; size: number }

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
  const best = candidates
    .filter((c) => semver.valid(c.entry.version) != null)
    .filter((c) => semver.satisfies(c.entry.version, range))
    .filter((c) => platformMatchesHost(c.entry.platform, deps.host))
    .filter((c) => isApiCompatible(c.entry.argusApi))
    .sort((a, b) => semver.rcompare(a.entry.version, b.entry.version))[0]
  if (!best) return null
  return {
    id,
    version: best.entry.version,
    download: {
      kind: 'gh-asset',
      ref,
      tag: best.tag,
      assetName: best.assetName,
      size: best.size
    },
    source,
    originLabel: `${source.host}/${source.owner}/${source.repo}`
  }
}
