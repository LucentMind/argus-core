import fs from 'node:fs'
import path from 'node:path'
import crypto from 'node:crypto'
import { readManifest } from './build'

export interface FeedOptions {
  /** The pack source dir — the authority for `id` and `argusApi`. */
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

export function buildFeed(opts: FeedOptions): FeedDocument {
  if (!/^https:\/\//.test(opts.baseUrl)) {
    throw new Error(`baseUrl must be https (Argus refuses to fetch anything else): ${opts.baseUrl}`)
  }
  if (opts.bundles.length === 0) throw new Error('no bundles given — nothing to publish')

  const manifest = readManifest(opts.packDir)
  const prefix = opts.baseUrl.replace(/\/+$/, '')

  const versions = opts.bundles.map((bundlePath): FeedVersion => {
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
    return {
      version,
      argusApi: manifest.argusApi,
      platform,
      url: `${prefix}/${name}`,
      sha256: crypto.createHash('sha256').update(fs.readFileSync(bundlePath)).digest('hex')
    }
  })

  return { id: manifest.id, versions }
}
