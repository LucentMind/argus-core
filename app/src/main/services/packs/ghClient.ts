import fs from 'node:fs'
import crypto from 'node:crypto'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import type { GhRef } from './githubRef'

const execFileAsync = promisify(execFile)

export const GH_TIMEOUT_MS = 20_000
export const GH_DOWNLOAD_TIMEOUT_MS = 300_000
/**
 * `gh api` output is JSON we buffer whole. Node's execFile default is 1 MiB and TRUNCATES
 * SILENTLY past it — a release list is small, but "small" is not a thing to bet a correctness
 * property on, and a truncated list would read as "no update published".
 */
export const GH_MAX_BUFFER = 16 * 1024 * 1024

export type GhErrorKind = 'missing' | 'auth' | 'notfound' | 'failed'

export class GhError extends Error {
  constructor(
    public kind: GhErrorKind,
    message: string
  ) {
    super(message)
    this.name = 'GhError'
  }
}

interface ExecFailure {
  code?: string | number
  stderr?: string
  message?: string
}

/**
 * Turns an execFile rejection into the one distinction the UI must make: is this fixable by the
 * user (install gh / log in), or is it the repo/network? 404 covers both "no such repo" and
 * "private, no access" — GitHub answers identically for the two and this must not pretend
 * otherwise.
 */
export function classifyGhFailure(err: unknown): GhError {
  const e = (err ?? {}) as ExecFailure
  const stderr = (e.stderr ?? '').trim()
  const detail = stderr || e.message || String(err)
  if (e.code === 'ENOENT') {
    return new GhError('missing', 'the GitHub CLI (gh) is not installed or not on PATH')
  }
  if (e.code === 4) {
    return new GhError('auth', `the GitHub CLI is not authenticated: ${detail}`)
  }
  if (/HTTP 404|Not Found/i.test(stderr)) {
    return new GhError('notfound', `repository not found, or your account cannot see it: ${detail}`)
  }
  return new GhError('failed', detail)
}

export interface GhClient {
  /** `path` is an API path such as `repos/o/r/releases?per_page=100`. Returns parsed JSON. */
  api(ref: GhRef, path: string): Promise<unknown>
  /** Downloads exactly one asset to `destPath` and reports what landed there. */
  downloadAsset(
    ref: GhRef,
    tag: string,
    assetName: string,
    destPath: string
  ): Promise<{ sha256: string; bytesWritten: number }>
}

/** `GH_NO_UPDATE_NOTIFIER` keeps gh's own upgrade nag out of stderr, where it would pollute
 *  every error message this module produces. */
const GH_ENV = { ...process.env, GH_NO_UPDATE_NOTIFIER: '1' }

export const nodeGhClient: GhClient = {
  async api(ref, path) {
    let stdout: string
    try {
      ;({ stdout } = await execFileAsync('gh', ['api', '--hostname', ref.host, path], {
        timeout: GH_TIMEOUT_MS,
        maxBuffer: GH_MAX_BUFFER,
        env: GH_ENV
      }))
    } catch (err) {
      throw classifyGhFailure(err)
    }
    try {
      return JSON.parse(stdout)
    } catch {
      throw new GhError('failed', 'gh returned output that is not JSON')
    }
  },

  async downloadAsset(ref, tag, assetName, destPath) {
    try {
      // `--output` writes ONE asset to an exact path, so there is no directory to scan
      // afterwards and no ambiguity about what landed. `-R [HOST/]OWNER/REPO` carries the host
      // inline, so an enterprise host needs no GH_HOST juggling. `--pattern` is a glob, but a
      // pack id is kebab-case and a version is semver, so no glob metacharacter can appear.
      await execFileAsync(
        'gh',
        [
          'release',
          'download',
          tag,
          '-R',
          `${ref.host}/${ref.owner}/${ref.repo}`,
          '--pattern',
          assetName,
          '--output',
          destPath,
          '--clobber'
        ],
        { timeout: GH_DOWNLOAD_TIMEOUT_MS, maxBuffer: GH_MAX_BUFFER, env: GH_ENV }
      )
    } catch (err) {
      throw classifyGhFailure(err)
    }
    return await hashFile(destPath)
  }
}

/** Hashes what actually landed on disk. gh writes the file itself, so — unlike the feed path's
 *  `getToFile` — there is no stream to hash during transfer and no way to enforce a byte cap
 *  mid-flight. The caller refuses oversized assets BEFORE downloading, using the size the API
 *  already reported. Every failure must be a GhError so callers narrowing on `.kind` see only
 *  classified failures. */
export async function hashFile(p: string): Promise<{ sha256: string; bytesWritten: number }> {
  try {
    const hash = crypto.createHash('sha256')
    let bytesWritten = 0
    await new Promise<void>((resolve, reject) => {
      const stream = fs.createReadStream(p)
      stream.on('data', (chunk) => {
        bytesWritten += chunk.length
        hash.update(chunk)
      })
      stream.on('error', reject)
      stream.on('end', () => resolve())
    })
    return { sha256: hash.digest('hex'), bytesWritten }
  } catch (err) {
    // `gh` can exit 0 without leaving a readable file behind (on Windows, an AV scanner
    // still holding the handle is the realistic case). Every failure out of this seam must
    // be a GhError, or a caller narrowing on `.kind` sees an unclassified Error instead.
    throw new GhError(
      'failed',
      `downloaded asset could not be read back: ${(err as Error).message}`
    )
  }
}
