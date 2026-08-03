import fs from 'node:fs'
import path from 'node:path'
import crypto from 'node:crypto'
import { once } from 'node:events'
import { finished } from 'node:stream/promises'
import { ZodError } from 'zod'
import { packFeedSchema, selectUpdate, type FeedEntry } from './feed'
import { findGithubUpdate, RepoMovedError, type GithubCandidate } from './githubFeed'
import { GhError, type GhClient } from './ghClient'
import { parseGhRef, sameGhRef } from './githubRef'
import {
  isGithubSource,
  type PacksStateStore,
  type PackSource,
  type FeedPackSource,
  type GithubPackSource
} from './packsState'
import { installPack, inspectBundleSource, describeUnsatisfied } from './install'
import type { UpdateStatus, UpdateErrorCode } from '../../../shared/updates'

/** A feed is a small JSON document; anything larger is a misconfiguration or hostile. */
export const MAX_FEED_BYTES = 1024 * 1024
/** Generous, because bundles legitimately carry native binaries. Its job is to bound a
 *  runaway or hostile response, not to be a tight fit. */
export const MAX_PACK_BUNDLE_BYTES = 512 * 1024 * 1024
export const FEED_TIMEOUT_MS = 10_000
export const DOWNLOAD_TIMEOUT_MS = 300_000

export interface HttpResponse {
  status: number
  /** The `Location` header, present on a 3xx. Its presence is how the caller detects a
   *  redirect it must refuse — this client never follows one. */
  location: string | null
  body: Buffer
}

/** Status/location alone — enough to check for a redirect, shared by `get` and `getToFile`. */
interface HttpStatus {
  status: number
  location: string | null
}

export interface HttpToFileResult extends HttpStatus {
  /** Digest of the bytes actually written. Meaningless (empty) when `status !== 200` — nothing
   *  is written to `destPath` in that case. */
  sha256: string
  bytesWritten: number
}

/**
 * Minimal HTTP seam so policy lives in the service and the service is testable offline.
 *
 * Both methods must throw `HttpTooLargeError` — not a plain `Error` — the instant the response
 * body exceeds the `maxBytes` passed in, so the service can report `code: 'too-large'` instead of
 * collapsing it into a generic transport-failure bucket. A second implementation that raced past
 * this contract would silently degrade every over-cap response to an ordinary failure.
 */
export interface HttpClient {
  get(url: string, opts: { maxBytes: number; timeoutMs: number }): Promise<HttpResponse>
  /**
   * Streams a response body straight to `destPath` while hashing it incrementally, rather than
   * buffering it in memory — this is the path the (potentially 512 MiB) pack bundle download
   * takes. `maxBytes` is enforced DURING the stream: the moment the running total exceeds it, the
   * partial file is removed and `HttpTooLargeError` is thrown. On a non-200 status (including any
   * redirect) nothing is ever written to `destPath` — the caller inspects `status`/`location`
   * before any body would be consumed. `sha256`/`bytesWritten` describe exactly what landed on
   * disk, so the caller can verify a checksum without a second read of the whole file.
   */
  getToFile(
    url: string,
    destPath: string,
    opts: { maxBytes: number; timeoutMs: number }
  ): Promise<HttpToFileResult>
}

/** Thrown by `nodeHttpClient` (and by fakes standing in for it) when a response exceeds the
 *  byte cap passed to `get()`/`getToFile()`. A distinct class — rather than a plain `Error` — so
 *  the service can tell "too large" apart from every other transport failure and report
 *  `code: 'too-large'` instead of collapsing it into the generic `'feed'`/`'download'` bucket. */
export class HttpTooLargeError extends Error {
  constructor(maxBytes: number) {
    super(`response exceeded ${maxBytes} bytes`)
    this.name = 'HttpTooLargeError'
  }
}

/** Production client: `redirect: 'manual'`, hard byte cap enforced while streaming. */
export const nodeHttpClient: HttpClient = {
  async get(url, { maxBytes, timeoutMs }) {
    const controller = new AbortController()
    const timer = setTimeout(() => controller.abort(), timeoutMs)
    try {
      const res = await fetch(url, { redirect: 'manual', signal: controller.signal })
      const reader = res.body?.getReader()
      const chunks: Buffer[] = []
      let total = 0
      if (reader) {
        for (;;) {
          const { done, value } = await reader.read()
          if (done) break
          total += value.byteLength
          if (total > maxBytes) {
            await reader.cancel()
            throw new HttpTooLargeError(maxBytes)
          }
          chunks.push(Buffer.from(value))
        }
      }
      return {
        status: res.status,
        location: res.headers.get('location'),
        body: Buffer.concat(chunks)
      }
    } finally {
      clearTimeout(timer)
    }
  },

  async getToFile(url, destPath, { maxBytes, timeoutMs }) {
    const controller = new AbortController()
    const timer = setTimeout(() => controller.abort(), timeoutMs)
    try {
      const res = await fetch(url, { redirect: 'manual', signal: controller.signal })
      const location = res.headers.get('location')
      if (res.status !== 200) {
        // Refuse a redirect (or any other non-200) before a single body byte is consumed —
        // don't even drain it, just let it be GC'd with the response.
        await res.body?.cancel().catch(() => {})
        return { status: res.status, location, sha256: '', bytesWritten: 0 }
      }

      const reader = res.body?.getReader()
      const hash = crypto.createHash('sha256')
      const out = fs.createWriteStream(destPath)
      let total = 0

      // A write failure (ENOSPC mid-download, EPERM/EBUSY from an AV scanner on Windows, …) is
      // emitted asynchronously from an fs callback, not thrown from anything we `await` — so a
      // stream with NO listener attached at the moment it fires becomes an uncaught exception
      // (a crash in the Electron main process), not a rejected promise. This listener is attached
      // synchronously, right after creation, before any `await` gives the stream a chance to
      // error with nothing listening. It only latches the failure into `writeError`; the loop
      // below is what turns that into a rejection, at the next point it checks.
      let writeError: Error | null = null
      out.on('error', (err: Error) => {
        writeError = err
      })

      const cleanupAndThrow = async (err: unknown): Promise<never> => {
        out.destroy()
        try {
          fs.rmSync(destPath, { force: true })
        } catch {
          // `force` only suppresses ENOENT — a Windows EPERM/EBUSY here (an AV scanner still
          // holding the partial file) must not replace `err` and downgrade e.g. a reported
          // 'too-large' into a generic 'download'. Best-effort only: the whole temp DIRECTORY
          // this file lives under is removed by apply()'s own `finally` regardless.
        }
        throw err
      }

      try {
        if (reader) {
          for (;;) {
            const { done, value } = await reader.read()
            if (done) break
            total += value.byteLength
            if (total > maxBytes) {
              await reader.cancel()
              await cleanupAndThrow(new HttpTooLargeError(maxBytes))
            }
            // Checked right here — immediately before the write, after the one `await` (the
            // `reader.read()` above) that could have given a PRIOR write's async failure time to
            // land while nothing was waiting on `out` at all. Left unchecked, `out.write()` below
            // would return `false` against an already-destroyed stream, and `events.once(out,
            // 'drain')` would wait forever: a destroyed stream never emits 'drain', and Node
            // emits a stream's 'error' event AT MOST ONCE, so there is no second chance for a
            // listener started only now to observe the failure that already happened.
            if (writeError) await cleanupAndThrow(writeError)
            hash.update(value)
            // `events.once` — rather than a hand-rolled `new Promise((resolve,reject)) =>
            // out.once('drain', ...); out.once('error', ...)` — both rejects this particular
            // wait the instant `out` errors AND removes its own listeners once it settles either
            // way. The hand-rolled version left its `'error'` listener behind forever on every
            // drain that resolved via `'drain'` instead, one more each time, eventually tripping
            // Node's MaxListenersExceededWarning on a large download.
            if (!out.write(value)) {
              await once(out, 'drain')
            }
          }
        }
        if (writeError) await cleanupAndThrow(writeError)
        out.end()
        // `finished()` is the promises-API replacement for manually juggling 'finish'/'error'
        // listeners on `end()` — it resolves when the stream finishes and rejects if it errors
        // at any point up to and including the final flush, without leaking a listener either.
        await finished(out)
      } catch (err) {
        return await cleanupAndThrow(err)
      }

      return { status: 200, location, sha256: hash.digest('hex'), bytesWritten: total }
    } finally {
      clearTimeout(timer)
    }
  }
}

class UpdateError extends Error {
  constructor(
    public code: UpdateErrorCode,
    message: string
  ) {
    super(message)
  }
}

export interface PackUpdatesDeps {
  argusHome: string
  state: PacksStateStore
  http: HttpClient
  /** Required for github-pinned packs. Absent only in tests that use feed pins exclusively. */
  gh?: GhClient
  /** Injected so tests can observe delegation. Production passes `installPack` itself. */
  install?: typeof installPack
  /** Injected so tests can fake the post-checksum identity check. Production passes the real
   *  `inspectBundleSource`. */
  inspectBundleSource?: typeof inspectBundleSource
  host?: { platform: string; arch: string }
  now?: () => number
}

/**
 * What `findUpdate` resolves to. `entry` is what the user is offered; `download` is how to fetch
 * it, and is the ONLY part that differs between a vendor feed and a GitHub release.
 */
type Selection =
  | { entry: FeedEntry; download: { kind: 'url'; url: string } }
  | {
      entry: FeedEntry
      download: {
        kind: 'gh'
        pin: GithubPackSource
        candidate: GithubCandidate
        manifestPath: string
      }
    }

export class PackUpdatesService {
  private readonly now: () => number
  private readonly install: typeof installPack
  private readonly inspectBundleSource: typeof inspectBundleSource

  constructor(private readonly deps: PackUpdatesDeps) {
    this.now = deps.now ?? Date.now
    this.install = deps.install ?? installPack
    this.inspectBundleSource = deps.inspectBundleSource ?? inspectBundleSource
  }

  /** One status per pack that has a recorded pin. Packs without one are absent entirely. */
  async checkAll(): Promise<Record<string, UpdateStatus>> {
    const sources = this.deps.state.listSources()
    const ids = Object.keys(sources)
    const results = await Promise.all(
      ids.map(async (id): Promise<[string, UpdateStatus]> => {
        try {
          const found = await this.findUpdate(id)
          return [
            id,
            found ? { phase: 'available', version: found.entry.version } : { phase: 'idle' }
          ]
        } catch (err) {
          return [id, this.errorOf(err)]
        }
      })
    )
    return Object.fromEntries(results)
  }

  /**
   * Re-fetches the feed rather than trusting a selection cached by `checkAll` — the feed may
   * have moved on, and a stale selection would download something the user never saw offered.
   */
  async apply(id: string): Promise<UpdateStatus> {
    let tmp: string | null = null
    try {
      const found = await this.findUpdate(id)
      if (!found) return { phase: 'idle' }
      const { entry, download } = found

      // Created under argusHome (not os.tmpdir()) because it's known-writable and has room for a
      // large bundle — NOT because installPack's later rename needs to be same-filesystem: it
      // extracts into its own `.pack-install-` staging dir (see install.ts's `stage()`) and
      // renames THAT, so this directory's filesystem is irrelevant to that swap.
      const dir = fs.mkdtempSync(path.join(this.deps.argusHome, '.pack-update-'))
      tmp = dir
      const zipPath = path.join(dir, `${id}.zip`)

      let sha256: string
      if (download.kind === 'url') {
        // Re-read the pin rather than trusting the one selection was made against: an uninstall
        // or reinstall racing this apply must still be caught. `pinOf` throws when the pin is
        // gone, which is the refusal the original code made here and which a fallback to the
        // stale pin would silently skip.
        const pin = this.pinOf(id)
        if (isGithubSource(pin)) {
          throw new UpdateError(
            'origin-pin',
            `pack '${id}' was re-pinned to a GitHub repository while this update was being prepared`
          )
        }
        this.assertHttps(download.url)
        if (new URL(download.url).origin !== pin.origin) {
          throw new UpdateError(
            'origin-pin',
            `bundle origin '${new URL(download.url).origin}' does not match the origin this pack was installed from ('${pin.origin}')`
          )
        }
        let dl: HttpToFileResult
        try {
          dl = await this.deps.http.getToFile(download.url, zipPath, {
            maxBytes: MAX_PACK_BUNDLE_BYTES,
            timeoutMs: DOWNLOAD_TIMEOUT_MS
          })
        } catch (err) {
          if (err instanceof HttpTooLargeError) throw new UpdateError('too-large', err.message)
          throw new UpdateError('download', (err as Error).message)
        }
        this.assertNoRedirect(dl)
        if (dl.status !== 200) {
          throw new UpdateError('download', `download failed: HTTP ${dl.status}`)
        }
        sha256 = dl.sha256
      } else {
        // gh writes the file itself, so the byte cap cannot be enforced mid-stream the way
        // getToFile does. Refuse on the size the API already reported instead — a bound on the
        // advertised size, which is the most this transport can offer. Documented in
        // docs/authoring-packs.md rather than left as an unstated difference.
        if (download.candidate.size > MAX_PACK_BUNDLE_BYTES) {
          throw new UpdateError(
            'too-large',
            `the published asset is ${download.candidate.size} bytes, over the ${MAX_PACK_BUNDLE_BYTES} byte limit`
          )
        }
        const gh = this.deps.gh
        if (!gh) throw new UpdateError('gh', 'the GitHub CLI client is not available')
        try {
          ;({ sha256 } = await gh.downloadAsset(
            download.pin,
            download.candidate.tag,
            download.candidate.assetName,
            zipPath
          ))
        } catch (err) {
          if (err instanceof GhError) throw new UpdateError('gh', err.message)
          throw new UpdateError('download', (err as Error).message)
        }
      }

      if (sha256 !== entry.sha256) {
        throw new UpdateError('checksum', 'downloaded bundle does not match the published checksum')
      }

      // The feed and origin only ever vouch for *a* bundle at this URL — `installPack` reads the
      // pack id it installs to, and the version it records, from INSIDE the zip. Without this
      // check, a compromised (or merely misconfigured) vendor could serve a zip for a different
      // pack entirely under a feed entry that passes every check above, silently taking over
      // that other pack and re-pinning its origin. Must run before `install()`: by the time
      // `install()` returns, the swap and the re-pin have already happened.
      let inspected: Awaited<ReturnType<typeof inspectBundleSource>>
      try {
        inspected = await this.inspectBundleSource(zipPath, {
          installed: this.deps.state.list()
        })
      } catch (err) {
        // A bundle that fails inspection (not a zip, no argus-pack.json, an invalid manifest)
        // throws install.ts's own InstallError, which is not an UpdateError — left uncaught,
        // errorOf()'s fallback would report `code: 'feed'`, the same code-collapsing Fix 6b
        // already corrected for a failed download. It is caused by the BUNDLE, not the feed
        // document, so it gets 'install' here too.
        throw new UpdateError('install', (err as Error).message)
      }
      if (inspected.id !== id) {
        throw new UpdateError(
          'install',
          `update bundle declares pack '${inspected.id}', expected '${id}' — refusing to install it under another pack's identity`
        )
      }
      if (inspected.version !== entry.version) {
        throw new UpdateError(
          'install',
          `update bundle declares version '${inspected.version}', expected '${entry.version}' from the feed entry`
        )
      }

      // A new version may declare a dependency the current one didn't. Refuse here, before the
      // swap, so the installed version stays active and the user is told what to install first —
      // Core never fetches a dependency on the user's behalf.
      const unsatisfied = describeUnsatisfied(inspected.id, inspected.dependencies)
      if (unsatisfied) throw new UpdateError('install', unsatisfied)

      // A github-pinned pack must stay pinned to the repo the bytes came from. Without this,
      // installPack re-derives the pin from the new bundle's manifest: a manifest naming a feed
      // would silently re-arm the feed path, and a manifest naming nothing at all would DELETE
      // the pin, leaving the pack permanently unchecked with no UI signal.
      // A manifest naming a DIFFERENT repo is still honoured — that is the documented way for a
      // vendor to move a pack deliberately.
      let pinOverride: PackSource | undefined
      if (download.kind === 'gh') {
        const declared = inspected.updateRepo ? parseGhRef(inspected.updateRepo) : null
        pinOverride =
          declared && !sameGhRef(declared, download.pin)
            ? undefined
            : { ...download.pin, manifestPath: download.manifestPath }
      }
      const result = await this.install(zipPath, {
        argusHome: this.deps.argusHome,
        state: this.deps.state,
        host: this.deps.host,
        pinOverride
      })
      if (!result.ok) throw new UpdateError('install', result.error)
      return { phase: 'ready', version: result.version }
    } catch (err) {
      return this.errorOf(err)
    } finally {
      // Cleanup failure (Windows EBUSY/EPERM from an AV scanner or installPack's own extract
      // still holding a handle on the just-written zip is realistic) must never escape apply()
      // and discard the UpdateStatus already computed above — it's best-effort only.
      if (tmp) {
        try {
          fs.rmSync(tmp, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 })
        } catch (err) {
          console.error(`pack update: failed to remove temp dir '${tmp}'`, err)
        }
      }
    }
  }

  private pinOf(id: string): PackSource {
    const pin = this.deps.state.getSource(id)
    if (!pin) throw new UpdateError('feed', `pack '${id}' has no recorded update source`)
    return pin
  }

  /** Fetches the pinned feed and selects, or throws an UpdateError. */
  private async findFeedUpdate(id: string, pin: FeedPackSource): Promise<FeedEntry | null> {
    this.assertHttps(pin.updateUrl)

    let res: HttpResponse
    try {
      res = await this.deps.http.get(pin.updateUrl, {
        maxBytes: MAX_FEED_BYTES,
        timeoutMs: FEED_TIMEOUT_MS
      })
    } catch (err) {
      if (err instanceof HttpTooLargeError) throw new UpdateError('too-large', err.message)
      throw new UpdateError('feed', (err as Error).message)
    }
    this.assertNoRedirect(res)
    if (res.status !== 200) throw new UpdateError('feed', `feed request failed: HTTP ${res.status}`)

    let feed
    try {
      feed = packFeedSchema.parse(JSON.parse(res.body.toString('utf8')))
    } catch (err) {
      // ZodError#message is a multi-line JSON blob — fine for a log, not for a settings row.
      // The first issue's message is the useful, human-sized part of it.
      const detail =
        err instanceof ZodError
          ? (err.issues[0]?.message ?? 'feed did not match the expected shape')
          : (err as Error).message
      throw new UpdateError('feed', `invalid feed: ${detail}`)
    }
    if (feed.id !== id) {
      throw new UpdateError('feed', `feed declares pack '${feed.id}', expected '${id}'`)
    }

    const installedVersion = this.deps.state.get(id)
    if (!installedVersion) throw new UpdateError('feed', `pack '${id}' is not installed`)
    const selected = selectUpdate(feed, {
      installedVersion,
      host: this.deps.host,
      origin: pin.origin
    })
    // selectUpdate stays pure and never throws (see its doc comment) — this is the one seam
    // that turns "every candidate was off-origin" into the same actionable `origin-pin` error
    // apply()'s own origin check produces, instead of collapsing it into a plain "idle" that
    // reads, to the user, exactly like a vendor who published nothing at all.
    if (selected.excludedByOriginOnly) {
      throw new UpdateError(
        'origin-pin',
        `an update to pack '${id}' exists but only from an origin other than the one this pack was installed from ('${pin.origin}')`
      )
    }
    return selected.entry
  }

  /** Dispatches on the pin kind. Everything downstream of this consumes a `Selection`. */
  private async findUpdate(id: string): Promise<Selection | null> {
    const pin = this.pinOf(id)
    if (!isGithubSource(pin)) {
      const entry = await this.findFeedUpdate(id, pin)
      // The `gh` arm below carries its pin because the download needs the host/owner/repo it was
      // resolved against; this arm carries none — `apply()` re-reads the pin itself for
      // freshness, so a stale copy here would only invite a fallback that defeats that check.
      return entry ? { entry, download: { kind: 'url', url: entry.url } } : null
    }

    const installedVersion = this.deps.state.get(id)
    if (!installedVersion) throw new UpdateError('feed', `pack '${id}' is not installed`)
    const gh = this.deps.gh
    if (!gh) throw new UpdateError('gh', 'the GitHub CLI client is not available')

    let found: Awaited<ReturnType<typeof findGithubUpdate>>
    try {
      found = await findGithubUpdate({ gh, host: this.deps.host }, pin, id, installedVersion)
    } catch (err) {
      // A moved repo is the gh-path analogue of a cross-origin redirect, so it reports through
      // the SAME code — the Packs row's "download it manually" branch is already written for it.
      if (err instanceof RepoMovedError) throw new UpdateError('origin-pin', err.message)
      if (err instanceof GhError) throw new UpdateError('gh', err.message)
      throw new UpdateError('feed', (err as Error).message)
    }
    if (!found) return null

    // Persist the resolved manifest path so the next check skips the tree search. Written on a
    // CHECK rather than only on apply: the search cost is paid whenever an update exists, not
    // only when the user takes it.
    if (found.manifestPath !== pin.manifestPath) {
      this.deps.state.setSource(id, { ...pin, manifestPath: found.manifestPath })
    }
    return {
      entry: found.candidate.entry,
      download: { kind: 'gh', pin, candidate: found.candidate, manifestPath: found.manifestPath }
    }
  }

  private assertHttps(url: string): void {
    let parsed: URL
    try {
      parsed = new URL(url)
    } catch {
      throw new UpdateError('insecure', `not a valid URL: ${url}`)
    }
    if (parsed.protocol !== 'https:') throw new UpdateError('insecure', `refusing non-https ${url}`)
  }

  private assertNoRedirect(res: HttpStatus): void {
    if (res.status >= 300 && res.status < 400) {
      throw new UpdateError(
        'redirect',
        `refusing to follow a redirect to ${res.location ?? '(none)'}`
      )
    }
  }

  private errorOf(err: unknown): UpdateStatus {
    const message = err instanceof Error ? err.message : String(err)
    const code =
      err instanceof UpdateError
        ? err.code
        : err instanceof HttpTooLargeError
          ? 'too-large'
          : 'feed'
    return { phase: 'error', message, at: this.now(), code }
  }
}
