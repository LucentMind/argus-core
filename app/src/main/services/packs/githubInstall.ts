import fs from 'node:fs'
import path from 'node:path'
import { z, ZodError } from 'zod'
import { installPack, inspectBundleSource } from './install'
import { isApiCompatible, platformMatchesHost } from './compat'
import { listReleaseCandidates, findGithubUpdate, MAX_RELEASES } from './githubFeed'
import { MAX_PACK_BUNDLE_BYTES } from './packUpdates'
import { GhError, type GhClient } from './ghClient'
import { parseGhRef, sameGhRef, type GhRef } from './githubRef'
import { PACK_MANIFEST_FILE } from './manifest'
import type { PacksStateStore } from './packsState'
import type { InstallResult, RepoPackRow } from '../../../shared/packs'

export interface GithubInstallDeps {
  gh: GhClient
  argusHome: string
  state: PacksStateStore
  host?: { platform: string; arch: string }
  install?: typeof installPack
  inspectBundleSource?: typeof inspectBundleSource
}

const releasesSchema = z.array(
  z.object({ tag_name: z.string(), draft: z.boolean(), prerelease: z.boolean() })
)

/**
 * The name GitHub actually resolved `ref` to. A repository that has been renamed or transferred
 * still ANSWERS under its old name, so a pin built from what the user typed would record a name
 * that is already dead — and the rename check in `githubFeed` would then fire on the next check,
 * against a pack that was installed perfectly legitimately. Pinning the canonical name instead
 * means the check only ever fires on a move that happened AFTER the install.
 *
 * Verified live: `gh api repos/facebook/jest --jq .full_name` answers `jestjs/jest`.
 */
export async function resolveCanonicalRef(gh: GhClient, ref: GhRef): Promise<GhRef> {
  const raw = await gh.api(ref, `repos/${ref.owner}/${ref.repo}`)
  const { full_name: fullName } = z.object({ full_name: z.string() }).parse(raw)
  const canonical = parseGhRef(`${ref.host}/${fullName}`)
  if (!canonical)
    throw new GhError('failed', `GitHub reported an unusable repository name: ${fullName}`)
  return canonical
}

/**
 * Every pack the repository's newest published release offers. Discovery is by TREE SEARCH, not
 * by path convention: `demo_pack` keeps its manifests under `packs/<id>/`, a single-pack repo
 * keeps one at the root, and neither layout is privileged.
 *
 * Incompatible packs are returned with `installable: false` and a reason rather than filtered
 * out — a pack that silently fails to appear reads as "this repo publishes nothing".
 */
export async function listRepoPacks(
  deps: { gh: GhClient; host?: { platform: string; arch: string } },
  typedRef: GhRef
): Promise<RepoPackRow[]> {
  // Resolve to the canonical name first, exactly as `installFromRepo` does — otherwise a renamed
  // or transferred repo trips `listReleaseCandidates`'s identity check, which reports itself in
  // terms of a PIN. Nothing is pinned yet here; the user is only discovering the repo.
  const ref = await resolveCanonicalRef(deps.gh, typedRef)
  const raw = await deps.gh.api(
    ref,
    `repos/${ref.owner}/${ref.repo}/releases?per_page=${MAX_RELEASES}`
  )
  const releases = releasesSchema.parse(raw)
  const newest = releases.find((r) => !r.draft && !r.prerelease)
  if (!newest) return []

  const treeRaw = await deps.gh.api(
    ref,
    `repos/${ref.owner}/${ref.repo}/git/trees/${encodeURIComponent(newest.tag_name)}?recursive=1`
  )
  const tree = z
    .object({ tree: z.array(z.object({ path: z.string(), type: z.string() })) })
    .parse(treeRaw)
  const manifestPaths = tree.tree
    .filter(
      (n) =>
        n.type === 'blob' &&
        (n.path === PACK_MANIFEST_FILE || n.path.endsWith(`/${PACK_MANIFEST_FILE}`))
    )
    .map((n) => n.path)

  const rows: RepoPackRow[] = []
  for (const manifestPath of manifestPaths) {
    const contents = await deps.gh.api(
      ref,
      `repos/${ref.owner}/${ref.repo}/contents/${manifestPath}?ref=${encodeURIComponent(newest.tag_name)}`
    )
    const parsed = z.object({ content: z.string() }).safeParse(contents)
    if (!parsed.success) continue
    let manifest: { id: string; version: string; argusApi: string }
    try {
      manifest = z
        .object({ id: z.string(), version: z.string(), argusApi: z.string() })
        .parse(JSON.parse(Buffer.from(parsed.data.content, 'base64').toString('utf8')))
    } catch {
      // A manifest that is present but unparseable drops THIS pack from the listing, exactly as
      // a schema-invalid one does. One broken manifest must not hide every valid pack in the
      // repo behind a generic error.
      continue
    }

    const candidates = await listReleaseCandidates(deps, ref, manifest.id)
    const forThisTag = candidates.filter(
      (c) => c.tag === newest.tag_name && platformMatchesHost(c.entry.platform, deps.host)
    )
    if (forThisTag.length === 0) {
      rows.push({
        id: manifest.id,
        version: manifest.version,
        tag: newest.tag_name,
        installable: false,
        reason: 'This release publishes no bundle for your platform.'
      })
      continue
    }
    const compatible = isApiCompatible(manifest.argusApi)
    rows.push({
      id: manifest.id,
      version: forThisTag[0].entry.version,
      tag: newest.tag_name,
      installable: compatible,
      reason: compatible ? undefined : "It isn't compatible with this version of Argus."
    })
  }
  return rows
}

/**
 * Downloads the newest compatible release of `packId` from `ref` and installs it, pinning the
 * pack to `ref`.
 *
 * The pin is the repository the bytes ACTUALLY came from, which overrides whatever the manifest
 * declares — the user chose a repo, and `demo_pack`'s packs declare a Pages feed they should not
 * be silently re-armed onto. The one exception is a manifest naming a DIFFERENT repo: a bundle
 * nominating another update home than its own source is the takeover shape `packUpdates.apply`
 * already refuses, so it is refused here too rather than resolved by precedence.
 */
export async function installFromRepo(
  deps: GithubInstallDeps,
  typedRef: GhRef,
  packId: string
): Promise<InstallResult> {
  const install = deps.install ?? installPack
  const inspect = deps.inspectBundleSource ?? inspectBundleSource
  let tmp: string | null = null
  try {
    // Pin what GitHub says the repo IS, not what the user typed — see `resolveCanonicalRef`.
    const ref = await resolveCanonicalRef(deps.gh, typedRef)
    const pin = { kind: 'github' as const, ...ref, installedAt: Date.now() }
    // Always '0.0.0', never the actually-installed version: this is how a pack installed from a
    // zip or a feed gets re-pointed at its repo — `listRepoPacks` has no notion of "installed" at
    // all, so the newest platform-matching, API-compatible release must be selectable regardless
    // of what (if anything) is already on disk.
    const found = await findGithubUpdate({ gh: deps.gh, host: deps.host }, pin, packId, '0.0.0')
    if (!found) {
      return {
        ok: false,
        code: 'io',
        error: `'${packId}' has no release in ${ref.owner}/${ref.repo} that runs on this machine`
      }
    }

    if (found.candidate.size > MAX_PACK_BUNDLE_BYTES) {
      return {
        ok: false,
        code: 'io',
        error: `the published asset is ${found.candidate.size} bytes, over the ${MAX_PACK_BUNDLE_BYTES} byte limit`
      }
    }

    tmp = fs.mkdtempSync(path.join(deps.argusHome, '.pack-install-gh-'))
    const zipPath = path.join(tmp, `${packId}.zip`)
    const { sha256 } = await deps.gh.downloadAsset(
      ref,
      found.candidate.tag,
      found.candidate.assetName,
      zipPath
    )
    if (sha256 !== found.candidate.entry.sha256) {
      return {
        ok: false,
        code: 'checksum',
        error: 'downloaded bundle does not match the published checksum'
      }
    }

    const inspected = await inspect(zipPath)
    if (inspected.id !== packId) {
      return {
        ok: false,
        code: 'manifest',
        error: `bundle declares pack '${inspected.id}', expected '${packId}'`
      }
    }
    if (inspected.updateRepo) {
      const declared = parseGhRef(inspected.updateRepo)
      if (!declared || !sameGhRef(declared, ref)) {
        return {
          ok: false,
          code: 'manifest',
          error: `this bundle names '${inspected.updateRepo}' as its update source, which is not the repository it was downloaded from — refusing to install it`
        }
      }
    }

    return await install(zipPath, {
      argusHome: deps.argusHome,
      state: deps.state,
      host: deps.host,
      pinOverride: { ...pin, manifestPath: found.manifestPath }
    })
  } catch (err) {
    if (err instanceof GhError) return { ok: false, code: 'io', error: err.message }
    // ZodError#message is a multi-line JSON blob — fine for a log, not a settings alert. The
    // first issue's message is the useful, human-sized part of it (mirrors packUpdates.ts's
    // findFeedUpdate).
    if (err instanceof ZodError) {
      return {
        ok: false,
        code: 'io',
        error: err.issues[0]?.message ?? 'repository response did not match the expected shape'
      }
    }
    return { ok: false, code: 'io', error: (err as Error).message }
  } finally {
    if (tmp) {
      try {
        fs.rmSync(tmp, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 })
      } catch (err) {
        console.error(`pack install: failed to remove temp dir '${tmp}'`, err)
      }
    }
  }
}
