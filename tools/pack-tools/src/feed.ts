import fs from 'node:fs'
import path from 'node:path'
import crypto from 'node:crypto'
import os from 'node:os'
import { extract } from 'zip-lib'
import { readManifest } from './build'
import {
  PACK_MANIFEST_FILE,
  packManifestSchema
} from '../../../app/src/main/services/packs/manifest'

export interface FeedOptions {
  /** The pack source dir — the authority for `id` (and, transitively, the hyphen-extension
   *  guard below). `argusApi` is NOT read from here — see `readBundleArgusApi`. */
  packDir: string
  /** Paths to built bundles, named as `build()` emits them. */
  bundles: string[]
  /** HTTPS prefix the bundles are served under. */
  baseUrl: string
}

export interface FeedVersion {
  version: string
  argusApi: string
  platform: string
  url: string
  sha256: string
}

export interface FeedDocument {
  id: string
  versions: FeedVersion[]
}

/**
 * Splits off the `<os>-<arch>.zip` suffix only. The id and version are then separated by the
 * KNOWN id from the manifest rather than by another hyphen rule — both may contain hyphens
 * (`code-graph`, `1.1.0-beta.1`), and a generic three-group regex silently mis-parses those,
 * yielding a feed that advertises version `beta.1`.
 */
const BUNDLE_TAIL = /^(.+)-([a-z0-9]+-[a-z0-9]+)\.zip$/

// Official SemVer 2.0.0 regex (see https://semver.org/#is-there-a-suggested-regular-expression-regex-to-check-a-semver-string).
const SEMVER = new RegExp(
  '^(0|[1-9]\\d*)\\.(0|[1-9]\\d*)\\.(0|[1-9]\\d*)' +
    '(?:-((?:0|[1-9]\\d*|\\d*[a-zA-Z-][0-9a-zA-Z-]*)(?:\\.(?:0|[1-9]\\d*|\\d*[a-zA-Z-][0-9a-zA-Z-]*))*))?' +
    '(?:\\+([0-9a-zA-Z-]+(?:\\.[0-9a-zA-Z-]+)*))?$'
)

/** Parsed (major, minor, patch, prerelease) — enough for a total order without a dependency. */
function parseSemver(v: string): {
  major: number
  minor: number
  patch: number
  prerelease: string | null
} {
  const m = SEMVER.exec(v)
  if (!m) throw new Error(`not valid semver: ${v}`) // unreachable: callers only pass SEMVER-tested strings
  return { major: Number(m[1]), minor: Number(m[2]), patch: Number(m[3]), prerelease: m[4] ?? null }
}

/**
 * Descending comparator for `Array.prototype.sort`. Not full SemVer 2.0.0 precedence (prerelease
 * identifiers are compared as plain strings, not numeric-vs-alpha per dot-separated field) — this
 * is a review/reproducibility aid for a published feed, not a compatibility gate (that's
 * `isApiCompatible`/`semver.gt` in Core), so an approximate order is an acceptable tradeoff for
 * not adding a dependency to a tool that otherwise has none for version math.
 */
function compareSemverDesc(a: string, b: string): number {
  const pa = parseSemver(a)
  const pb = parseSemver(b)
  if (pa.major !== pb.major) return pb.major - pa.major
  if (pa.minor !== pb.minor) return pb.minor - pa.minor
  if (pa.patch !== pb.patch) return pb.patch - pa.patch
  // A release (no prerelease) outranks any prerelease of the same major.minor.patch.
  if (pa.prerelease == null && pb.prerelease != null) return -1
  if (pa.prerelease != null && pb.prerelease == null) return 1
  if (pa.prerelease == null && pb.prerelease == null) return 0
  return pa.prerelease! < pb.prerelease! ? 1 : pa.prerelease! > pb.prerelease! ? -1 : 0
}

/**
 * Reads `argusApi` from the BUNDLE's own manifest, not the source manifest passed via `packDir`,
 * and asserts the bundle's own declared `id`/`version` agree with what its FILENAME claims.
 *
 * The plan originally stamped every entry with the source manifest's current `argusApi`
 * ("unzipping each bundle would be wasteful"). That forces a single-version feed: after a vendor
 * bumps their source manifest to `argusApi: "^2"`, regenerating the feed would silently relabel
 * an older, still-published `1.1.0` bundle as requiring `^2` too — stranding every user on a `^1`
 * Core with an update that was actually built for them. That defeats the entire reason
 * `packFeedSchema.versions` is a LIST rather than a `latest` pointer (see feed.ts's doc comment
 * in `app/src/main/services/packs/feed.ts`). Reading each bundle's own manifest is not
 * meaningfully more expensive at publish time, so the human overruled the original tradeoff.
 *
 * The id/version cross-check (Minor c of the final review) exists because `app/.../packUpdates.ts`
 * `apply()` treats a mismatch between a downloaded bundle's manifest and the feed entry that
 * pointed at it as FATAL, for every user, at update time — refusing to install it under another
 * pack's identity. The manifest is already being parsed here to read `argusApi`; asserting it
 * agrees with what the filename (id, version) and `packDir` (id) claim catches a bundle built
 * from a stale or mislabeled source before it is ever published, rather than after every user's
 * update attempt starts failing.
 */
async function readBundleArgusApi(
  bundlePath: string,
  expected: { id: string; version: string }
): Promise<string> {
  const name = path.basename(bundlePath)
  const tmp = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'packtools-feed-')))
  try {
    try {
      await extract(bundlePath, tmp, { safeSymlinksOnly: true })
    } catch (err) {
      throw new Error(`bundle '${name}' could not be read as a zip: ${(err as Error).message}`)
    }
    const manifestPath = path.join(tmp, PACK_MANIFEST_FILE)
    if (!fs.existsSync(manifestPath)) {
      throw new Error(`bundle '${name}' has no ${PACK_MANIFEST_FILE} inside it`)
    }
    let raw: unknown
    try {
      raw = JSON.parse(fs.readFileSync(manifestPath, 'utf8'))
    } catch (err) {
      throw new Error(`bundle '${name}' has an unreadable ${PACK_MANIFEST_FILE}: ${(err as Error).message}`)
    }
    const parsed = packManifestSchema.safeParse(raw)
    if (!parsed.success) {
      throw new Error(
        `bundle '${name}' has an invalid ${PACK_MANIFEST_FILE}: ${parsed.error.issues[0]?.message ?? parsed.error.message}`
      )
    }
    if (parsed.data.id !== expected.id) {
      throw new Error(
        `bundle '${name}' declares pack id '${parsed.data.id}' in its manifest, but its filename ` +
          `(and source pack) says '${expected.id}' — refusing to publish a feed entry whose bundle ` +
          `disagrees with itself`
      )
    }
    if (parsed.data.version !== expected.version) {
      throw new Error(
        `bundle '${name}' declares version '${parsed.data.version}' in its manifest, but its ` +
          `filename says '${expected.version}' — refusing to publish a feed entry whose bundle ` +
          `disagrees with itself`
      )
    }
    return parsed.data.argusApi
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true })
  }
}

export async function buildFeed(opts: FeedOptions): Promise<FeedDocument> {
  let parsedBase: URL
  try {
    parsedBase = new URL(opts.baseUrl)
  } catch {
    throw new Error(`baseUrl is not a valid URL: ${opts.baseUrl}`)
  }
  if (parsedBase.protocol !== 'https:') {
    throw new Error(`baseUrl must be https (Argus refuses to fetch anything else): ${opts.baseUrl}`)
  }
  if (opts.bundles.length === 0) throw new Error('no bundles given — nothing to publish')

  const manifest = readManifest(opts.packDir)
  const prefix = opts.baseUrl.replace(/\/+$/, '')

  const versions: FeedVersion[] = []
  for (const bundlePath of opts.bundles) {
    const name = path.basename(bundlePath)
    const m = BUNDLE_TAIL.exec(name)
    if (!m) {
      throw new Error(`filename must be <id>-<version>-<os>-<arch>.zip, got '${name}'`)
    }
    const [, head, platform] = m
    if (!head.startsWith(`${manifest.id}-`)) {
      throw new Error(`bundle '${name}' does not belong to pack '${manifest.id}'`)
    }
    const version = head.slice(manifest.id.length + 1)
    if (version === '') {
      throw new Error(`filename must be <id>-<version>-<os>-<arch>.zip, got '${name}'`)
    }
    // A bundle whose pack id is a hyphen-extension of `manifest.id` (e.g. 'sample-extra' vs
    // 'sample') passes the startsWith check above but leaves a garbage tail — like
    // 'extra-1.0.0' — sliced off as the "version". Reject anything that isn't valid semver so
    // that collision can't silently reach the published feed.
    if (!SEMVER.test(version)) {
      throw new Error(
        `bundle '${name}' does not belong to pack '${manifest.id}' (parsed version '${version}' is not valid semver — check for another pack whose id is a hyphen-extension of '${manifest.id}')`
      )
    }
    // Filename checks above are cheap and synchronous, so a bundle that's obviously wrong (bad
    // name, wrong pack) fails fast without ever needing to be a valid zip. Only a bundle that's
    // passed all of that is actually opened to read its own argusApi (and to cross-check its own
    // declared id/version against what this filename claims — Minor c).
    const argusApi = await readBundleArgusApi(bundlePath, { id: manifest.id, version })
    versions.push({
      version,
      argusApi,
      platform,
      url: `${prefix}/${name}`,
      sha256: crypto.createHash('sha256').update(fs.readFileSync(bundlePath)).digest('hex')
    })
  }

  // Descending by version so a published feed is reviewable across runs (newest first) rather
  // than in whatever order the OS happened to list the bundle files.
  versions.sort((a, b) => compareSemverDesc(a.version, b.version))

  return { id: manifest.id, versions }
}
