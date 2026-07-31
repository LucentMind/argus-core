import fs from 'node:fs'
import path from 'node:path'
import crypto from 'node:crypto'
import { packFeedSchema, selectUpdate, type FeedEntry } from './feed'
import type { PacksStateStore } from './packsState'
import { installPack } from './install'
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

/** Minimal HTTP seam so policy lives in the service and the service is testable offline. */
export interface HttpClient {
  get(url: string, opts: { maxBytes: number; timeoutMs: number }): Promise<HttpResponse>
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
            throw new Error(`response exceeded ${maxBytes} bytes`)
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
  /** Injected so tests can observe delegation. Production passes `installPack` itself. */
  install?: typeof installPack
  host?: { platform: string; arch: string }
  now?: () => number
}

export class PackUpdatesService {
  private readonly now: () => number
  private readonly install: typeof installPack

  constructor(private readonly deps: PackUpdatesDeps) {
    this.now = deps.now ?? Date.now
    this.install = deps.install ?? installPack
  }

  /** One status per pack that has a recorded pin. Packs without one are absent entirely. */
  async checkAll(): Promise<Record<string, UpdateStatus>> {
    const sources = this.deps.state.listSources()
    const ids = Object.keys(sources)
    const results = await Promise.all(
      ids.map(async (id): Promise<[string, UpdateStatus]> => {
        try {
          const entry = await this.findUpdate(id)
          return [id, entry ? { phase: 'available', version: entry.version } : { phase: 'idle' }]
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
      const entry = await this.findUpdate(id)
      if (!entry) return { phase: 'idle' }

      const pin = this.pinOf(id)
      this.assertHttps(entry.url)
      if (new URL(entry.url).origin !== pin.origin) {
        throw new UpdateError(
          'origin-pin',
          `bundle origin '${new URL(entry.url).origin}' does not match the origin this pack was installed from ('${pin.origin}')`
        )
      }

      const res = await this.deps.http.get(entry.url, {
        maxBytes: MAX_PACK_BUNDLE_BYTES,
        timeoutMs: DOWNLOAD_TIMEOUT_MS
      })
      this.assertNoRedirect(res)
      if (res.status !== 200) throw new UpdateError('feed', `download failed: HTTP ${res.status}`)

      const actual = crypto.createHash('sha256').update(res.body).digest('hex')
      if (actual !== entry.sha256) {
        throw new UpdateError('checksum', 'downloaded bundle does not match the feed checksum')
      }

      // Written onto the packs volume so installPack's later rename is same-filesystem.
      const dir = fs.mkdtempSync(path.join(this.deps.argusHome, '.pack-update-'))
      tmp = dir
      const zipPath = path.join(dir, `${id}.zip`)
      fs.writeFileSync(zipPath, res.body)

      const result = await this.install(zipPath, {
        argusHome: this.deps.argusHome,
        state: this.deps.state
      })
      if (!result.ok) throw new UpdateError('install', result.error)
      return { phase: 'ready', version: result.version }
    } catch (err) {
      return this.errorOf(err)
    } finally {
      if (tmp) fs.rmSync(tmp, { recursive: true, force: true })
    }
  }

  private pinOf(id: string): { origin: string; updateUrl: string } {
    const pin = this.deps.state.getSource(id)
    if (!pin) throw new UpdateError('feed', `pack '${id}' has no recorded update source`)
    return pin
  }

  /** Fetches the pinned feed and selects, or throws an UpdateError. */
  private async findUpdate(id: string): Promise<FeedEntry | null> {
    const pin = this.pinOf(id)
    this.assertHttps(pin.updateUrl)

    let res: HttpResponse
    try {
      res = await this.deps.http.get(pin.updateUrl, {
        maxBytes: MAX_FEED_BYTES,
        timeoutMs: FEED_TIMEOUT_MS
      })
    } catch (err) {
      throw new UpdateError('feed', (err as Error).message)
    }
    this.assertNoRedirect(res)
    if (res.status !== 200) throw new UpdateError('feed', `feed request failed: HTTP ${res.status}`)

    let feed
    try {
      feed = packFeedSchema.parse(JSON.parse(res.body.toString('utf8')))
    } catch (err) {
      throw new UpdateError('feed', `invalid feed: ${(err as Error).message}`)
    }
    if (feed.id !== id) {
      throw new UpdateError('feed', `feed declares pack '${feed.id}', expected '${id}'`)
    }

    const installedVersion = this.deps.state.get(id)
    if (!installedVersion) throw new UpdateError('feed', `pack '${id}' is not installed`)
    return selectUpdate(feed, { installedVersion, host: this.deps.host })
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

  private assertNoRedirect(res: HttpResponse): void {
    if (res.status >= 300 && res.status < 400) {
      throw new UpdateError(
        'redirect',
        `refusing to follow a redirect to ${res.location ?? '(none)'}`
      )
    }
  }

  private errorOf(err: unknown): UpdateStatus {
    const message = err instanceof Error ? err.message : String(err)
    const code = err instanceof UpdateError ? err.code : 'feed'
    return { phase: 'error', message, at: this.now(), code }
  }
}
