import path from 'node:path'
import os from 'node:os'
import { describe, it, expect } from 'vitest'
import { classifyGhFailure, GhError, ghEnv, hashFile } from '../ghClient'

describe('ghEnv', () => {
  // The regression: PATH was spread into a module-level const. `hydratePathFromLoginShell`
  // repairs process.env.PATH inside app.whenReady(), i.e. AFTER every static import has been
  // evaluated, so the snapshot kept the minimal launchd PATH a Finder-launched macOS app gets
  // and every gh spawn came back ENOENT — reported as "gh is not installed".
  it('reads PATH when the child is spawned, not when the module was loaded', () => {
    const before = process.env.PATH
    try {
      process.env.PATH = `${before ?? ''}${path.delimiter}/argus-hydrated-late`
      expect(ghEnv().PATH).toContain('/argus-hydrated-late')
    } finally {
      process.env.PATH = before
    }
  })

  it('silences gh’s upgrade nag so it cannot pollute stderr-derived messages', () => {
    expect(ghEnv().GH_NO_UPDATE_NOTIFIER).toBe('1')
  })
})

describe('classifyGhFailure', () => {
  it('reports a missing gh binary distinctly', () => {
    const err = Object.assign(new Error('spawn gh ENOENT'), { code: 'ENOENT' })
    expect(classifyGhFailure(err).kind).toBe('missing')
  })

  // `gh help exit-codes`: 4 means authentication required. Distinguished because the fix is
  // `gh auth login`, not a retry — and Health already has a check to point the user at.
  it('reports exit code 4 as an auth failure', () => {
    const err = Object.assign(new Error('exited with 4'), { code: 4, stderr: '' })
    expect(classifyGhFailure(err).kind).toBe('auth')
  })

  it('reports a 404 as not-found', () => {
    const err = Object.assign(new Error('failed'), {
      code: 1,
      stderr: 'gh: Not Found (HTTP 404)'
    })
    expect(classifyGhFailure(err).kind).toBe('notfound')
  })

  it('falls back to a generic failure', () => {
    const err = Object.assign(new Error('boom'), { code: 1, stderr: 'unexpected' })
    expect(classifyGhFailure(err).kind).toBe('failed')
  })

  it('keeps stderr in the message, so the row says something actionable', () => {
    const err = Object.assign(new Error('boom'), { code: 1, stderr: 'SAML enforcement failed' })
    expect(classifyGhFailure(err).message).toContain('SAML enforcement failed')
  })

  it('is a GhError, so callers can narrow on it', () => {
    expect(classifyGhFailure(new Error('x'))).toBeInstanceOf(GhError)
  })
})

describe('hashFile failures', () => {
  it('reports an unreadable downloaded asset as a GhError, not a raw Error', async () => {
    // Exercises the hash-back step in isolation: `gh` exiting 0 without leaving a readable
    // file is the real-world case (AV holding the handle on Windows).
    const missing = path.join(os.tmpdir(), 'argus-gh-does-not-exist', 'asset.zip')
    await expect(hashFile(missing)).rejects.toBeInstanceOf(GhError)
  })
})
