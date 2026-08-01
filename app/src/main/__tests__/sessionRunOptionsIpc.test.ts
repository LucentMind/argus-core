import { describe, it, expect } from 'vitest'
import { assertPermissionMode } from '../services/agent/sessionStore'

describe('assertPermissionMode', () => {
  it('accepts every real mode', () => {
    for (const m of ['default', 'acceptEdits', 'plan', 'bypassPermissions']) {
      expect(() => assertPermissionMode(m)).not.toThrow()
    }
  })

  it('rejects anything else, since a bad mode would strand the chat', () => {
    expect(() => assertPermissionMode('bogus')).toThrow(/permission mode/i)
    expect(() => assertPermissionMode(undefined)).toThrow(/permission mode/i)
  })
})
