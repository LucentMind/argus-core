import { describe, it, expect } from 'vitest'
import { ATLASSIAN_ERROR_CODES, type JiraResult } from '../jira'

describe('shared/jira', () => {
  it('error codes cover the spec §3.1 mapping', () => {
    for (const c of ['not-configured', 'auth', 'not-found', 'network', 'http', 'internal'])
      expect(ATLASSIAN_ERROR_CODES).toContain(c)
  })
  it('JiraResult discriminates on ok', () => {
    const ok: JiraResult<number> = { ok: true, value: 1 }
    const err: JiraResult<number> = { ok: false, code: 'auth', message: 'nope' }
    expect(ok.ok && ok.value).toBe(1)
    expect(!err.ok && err.code).toBe('auth')
  })
})
