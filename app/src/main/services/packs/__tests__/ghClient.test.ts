import { describe, it, expect } from 'vitest'
import { classifyGhFailure, GhError } from '../ghClient'

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
