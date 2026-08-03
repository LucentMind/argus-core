import { z } from 'zod'
import semver from 'semver'
import { selectUpdate, type FeedEntry, type PackFeed } from './feed'
import { platformMatchesHost } from './compat'
import { GhError, type GhClient } from './ghClient'
import { parseGhRef, sameGhRef, formatGhRef, type GhRef } from './githubRef'
import type { GithubPackSource } from './packsState'
import { PACK_MANIFEST_FILE } from './manifest'

/**
 * The newest releases considered. Deliberately not paginated: `gh api --paginate` without
 * `--slurp` emits concatenated JSON arrays that are not valid JSON, and a pack whose newest
 * COMPATIBLE release is more than 100 releases old is not a case worth a second round trip.
 * If nothing here is compatible the check reports idle, which is the honest answer.
 */
export const MAX_RELEASES = 100

/** A feed entry, plus the two things a `gh release download` needs that a feed URL does not. */
export interface GithubCandidate {
  entry: FeedEntry
  tag: string
  assetName: string
  /** As reported by the API. The pre-download size check uses this — see `ghClient.hashFile`. */
  size: number
}

/**
 * Raised when a release cannot be confirmed to belong to the pinned repository — either it
 * reports a DIFFERENT canonical repo (renamed or transferred), or its `html_url` is missing or
 * unparseable so nothing can be confirmed at all. Both are refusals: this check is the gh-path
 * analogue of the feed path's redirect refusal, and a check that cannot verify must not pass.
 */
export class RepoMovedError extends Error {
  constructor(
    /** The canonical repo GitHub reported, or `null` when it could not be determined. */
    public actual: string | null,
    public expected: string
  ) {
    super(
      actual === null
        ? `could not confirm from GitHub's response that this release belongs to '${expected}'`
        : `this pack is pinned to '${expected}', but GitHub now answers for it as '${actual}' — the repository was renamed or transferred`
    )
    this.name = 'RepoMovedError'
  }
}

const assetSchema = z.object({
  name: z.string(),
  size: z.number(),
  /** Absent or null on assets uploaded before GitHub computed digests. Such an asset is SKIPPED:
   *  a checksum is not optional here, and there is nowhere else to get one. */
  digest: z.string().nullish(),
  browser_download_url: z.string()
})

const releaseSchema = z.object({
  tag_name: z.string(),
  draft: z.boolean(),
  prerelease: z.boolean(),
  html_url: z.string(),
  assets: z.array(assetSchema)
})

const treeSchema = z.object({
  tree: z.array(z.object({ path: z.string(), type: z.string() }))
})

const contentsSchema = z.object({ content: z.string() })

/** Only `id` and `argusApi` are read; every other manifest field is validated at install. */
const partialManifestSchema = z.object({ id: z.string(), argusApi: z.string() })

/** Splits off the `<os>-<arch>.zip` suffix only — mirrors `tools/pack-tools/src/feed.ts`. */
const ASSET_TAIL = /^(.+)-([a-z0-9]+-[a-z0-9]+)\.zip$/

/**
 * Id and version are separated by the KNOWN pack id, never by another hyphen rule: both may
 * contain hyphens (`code-graph`, `1.1.0-beta.1`), and a generic three-group regex silently
 * yields version `beta.1`.
 */
export function parseAssetName(
  assetName: string,
  packId: string
): { version: string; platform: string } | null {
  const m = ASSET_TAIL.exec(assetName)
  if (!m) return null
  const [, head, platform] = m
  if (!head.startsWith(`${packId}-`)) return null
  const version = head.slice(packId.length + 1)
  return semver.valid(version) == null ? null : { version, platform }
}

/**
 * `https://<host>/<owner>/<repo>/releases/tag/<tag>` → the canonical repo GitHub resolved the
 * request to. A renamed or transferred repo still ANSWERS under its old name, but reports its
 * new one here — verified live against `facebook/jest`, whose releases report `jestjs/jest`.
 * This is the gh-path analogue of the feed path's redirect refusal, at zero extra API calls.
 */
export function repoOfHtmlUrl(htmlUrl: string): GhRef | null {
  let url: URL
  try {
    url = new URL(htmlUrl)
  } catch {
    return null
  }
  const [owner, repo] = url.pathname.split('/').filter(Boolean)
  if (!owner || !repo) return null
  return parseGhRef(`${url.hostname}/${owner}/${repo}`)
}

export interface GithubFeedDeps {
  gh: GhClient
  host?: { platform: string; arch: string }
}

/** Every non-draft, non-prerelease release asset belonging to `packId`, newest release first. */
export async function listReleaseCandidates(
  deps: GithubFeedDeps,
  pin: GhRef,
  packId: string
): Promise<GithubCandidate[]> {
  const raw = await deps.gh.api(
    pin,
    `repos/${pin.owner}/${pin.repo}/releases?per_page=${MAX_RELEASES}`
  )
  const releases = z.array(releaseSchema).parse(raw)

  const out: GithubCandidate[] = []
  for (const release of releases) {
    const actual = repoOfHtmlUrl(release.html_url)
    if (!actual || !sameGhRef(actual, pin)) {
      throw new RepoMovedError(actual && formatGhRef(actual), formatGhRef(pin))
    }
    if (release.draft || release.prerelease) continue
    for (const asset of release.assets) {
      const parsed = parseAssetName(asset.name, packId)
      if (!parsed) continue
      const digest = asset.digest?.startsWith('sha256:')
        ? asset.digest.slice('sha256:'.length)
        : null
      if (!digest) continue
      out.push({
        tag: release.tag_name,
        assetName: asset.name,
        size: asset.size,
        entry: {
          version: parsed.version,
          platform: parsed.platform,
          url: asset.browser_download_url,
          sha256: digest,
          // Filled in by hydration. Never selected on until it is — see `findGithubUpdate`.
          argusApi: ''
        }
      })
    }
  }
  return out
}

/** Reads `<path>` at `<tag>`, or `null` if it is absent/unreadable/not a pack manifest. */
async function tryManifest(
  deps: GithubFeedDeps,
  pin: GhRef,
  tag: string,
  path: string
): Promise<{ id: string; argusApi: string } | null> {
  try {
    const raw = await deps.gh.api(
      pin,
      `repos/${pin.owner}/${pin.repo}/contents/${path}?ref=${encodeURIComponent(tag)}`
    )
    const { content } = contentsSchema.parse(raw)
    return partialManifestSchema.parse(JSON.parse(Buffer.from(content, 'base64').toString('utf8')))
  } catch (err) {
    // A 404 is the legitimate "no manifest at this path" case the tree search relies on while
    // it tries candidates. Every other GhError — auth, rate limit, transport — is actionable:
    // swallowing it here would turn it into "this release has no manifest", and then into a
    // false "no update available", hiding a problem the user can actually fix.
    if (err instanceof GhError && err.kind !== 'notfound') throw err
    return null
  }
}

/**
 * Locates `packId`'s manifest in the tagged tree and returns its path and `argusApi`. The pinned
 * path is a hint tried first; it is re-validated against the manifest's declared `id`, so a pack
 * that moved within its repo self-heals instead of silently reading a neighbour's compatibility.
 */
export async function readPackManifest(
  deps: GithubFeedDeps,
  pin: GithubPackSource,
  tag: string,
  packId: string
): Promise<{ argusApi: string; manifestPath: string } | null> {
  if (pin.manifestPath) {
    const hinted = await tryManifest(deps, pin, tag, pin.manifestPath)
    if (hinted?.id === packId) {
      return { argusApi: hinted.argusApi, manifestPath: pin.manifestPath }
    }
  }

  let tree
  try {
    const raw = await deps.gh.api(
      pin,
      `repos/${pin.owner}/${pin.repo}/git/trees/${encodeURIComponent(tag)}?recursive=1`
    )
    tree = treeSchema.parse(raw)
  } catch (err) {
    if (err instanceof GhError) throw err
    return null
  }

  const paths = tree.tree
    .filter((n) => n.type === 'blob' && n.path.endsWith(`/${PACK_MANIFEST_FILE}`))
    .map((n) => n.path)
  if (tree.tree.some((n) => n.type === 'blob' && n.path === PACK_MANIFEST_FILE)) {
    paths.push(PACK_MANIFEST_FILE)
  }
  // Try a path that mentions the pack id first — `packs/<id>/argus-pack.json` and the
  // single-pack repo root are the two real layouts, and this makes both cost one read. The
  // MATCH is still on the manifest's declared `id`; the ordering is only a hint.
  paths.sort((a, b) => Number(b.includes(packId)) - Number(a.includes(packId)))

  for (const path of paths) {
    const m = await tryManifest(deps, pin, tag, path)
    if (m?.id === packId) return { argusApi: m.argusApi, manifestPath: path }
  }
  return null
}

/**
 * The newest release of `packId` that is newer than `installedVersion`, targets this host, and
 * is API-compatible with this Core — or `null`.
 *
 * `argusApi` is hydrated LAZILY, newest-first, stopping at the first compatible release: it is
 * the only field a release listing cannot supply, and paying a manifest read per release would
 * make a routine check proportional to release history. `selectUpdate` still has the final say
 * over the hydrated set, so version/platform/semver rules keep exactly one implementation.
 */
export async function findGithubUpdate(
  deps: GithubFeedDeps,
  pin: GithubPackSource,
  packId: string,
  installedVersion: string
): Promise<{ candidate: GithubCandidate; manifestPath: string } | null> {
  const all = await listReleaseCandidates(deps, pin, packId)

  // No defensible comparison exists against an installed version that is not valid semver.
  if (semver.valid(installedVersion) == null) return null

  const newer = all
    .filter(
      (c) =>
        semver.gt(c.entry.version, installedVersion) &&
        platformMatchesHost(c.entry.platform, deps.host)
    )
    .sort((a, b) => semver.rcompare(a.entry.version, b.entry.version))

  for (const candidate of newer) {
    const manifest = await readPackManifest(deps, pin, candidate.tag, packId)
    if (!manifest) continue
    const hydrated: GithubCandidate = {
      ...candidate,
      entry: { ...candidate.entry, argusApi: manifest.argusApi }
    }
    const feed: PackFeed = { id: packId, versions: [hydrated.entry] }
    const selected = selectUpdate(feed, { installedVersion, host: deps.host })
    if (selected.entry) return { candidate: hydrated, manifestPath: manifest.manifestPath }
  }
  return null
}
