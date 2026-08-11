import { describe, it, expect } from 'vitest'
import { assertPermissionMode } from '../services/agent/sessionStore'
import { PERMISSION_MODES } from '../../shared/settings'

describe('assertPermissionMode', () => {
  it('accepts every real mode', () => {
    for (const m of PERMISSION_MODES) {
      expect(() => assertPermissionMode(m)).not.toThrow()
    }
  })

  it('rejects anything else, since a bad mode would strand the chat', () => {
    expect(() => assertPermissionMode('bogus')).toThrow(/permission mode/i)
    expect(() => assertPermissionMode(undefined)).toThrow(/permission mode/i)
  })
})
