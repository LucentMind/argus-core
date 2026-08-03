import fs from 'node:fs'
import path from 'node:path'
import { z } from 'zod'
import { installPack, inspectBundleSource } from './install'
import { isApiCompatible, platformMatchesHost } from './compat'
import { listReleaseCandidates, findGithubUpdate, MAX_RELEASES } from './githubFeed'
import { GhError, type GhClient } from './ghClient'
import { parseGhRef, sameGhRef, type GhRef } from './githubRef'
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
  ref: GhRef
): Promise<RepoPackRow[]> {
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
    .filter((n) => n.type === 'blob' && n.path.endsWith('argus-pack.json'))
    .map((n) => n.path)

  const rows: RepoPackRow[] = []
  for (const manifestPath of manifestPaths) {
    const contents = await deps.gh.api(
      ref,
      `repos/${ref.owner}/${ref.repo}/contents/${manifestPath}?ref=${encodeURIComponent(newest.tag_name)}`
    )
    const parsed = z.object({ content: z.string() }).safeParse(contents)
    if (!parsed.success) continue
    const manifest = z
      .object({ id: z.string(), version: z.string(), argusApi: z.string() })
      .safeParse(JSON.parse(Buffer.from(parsed.data.content, 'base64').toString('utf8')))
    if (!manifest.success) continue

    const candidates = await listReleaseCandidates(deps, ref, manifest.data.id)
    const forThisTag = candidates.filter(
      (c) => c.tag === newest.tag_name && platformMatchesHost(c.entry.platform, deps.host)
    )
    if (forThisTag.length === 0) {
      rows.push({
        id: manifest.data.id,
        version: manifest.data.version,
        tag: newest.tag_name,
        installable: false,
        reason: 'This release publishes no bundle for your platform.'
      })
      continue
    }
    const compatible = isApiCompatible(manifest.data.argusApi)
    rows.push({
      id: manifest.data.id,
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
    const installed = deps.state.get(packId) ?? '0.0.0'
    const found = await findGithubUpdate({ gh: deps.gh, host: deps.host }, pin, packId, installed)
    if (!found) {
      return {
        ok: false,
        code: 'manifest',
        error: `'${packId}' has no release in ${ref.owner}/${ref.repo} that is newer than what is installed and runs on this machine`
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
