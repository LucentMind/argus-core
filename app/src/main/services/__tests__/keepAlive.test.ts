import { describe, it, expect } from 'vitest'
import { shouldKeepAlive } from '../keepAlive'

describe('shouldKeepAlive', () => {
  it('keeps a Windows app alive only when the setting is on', () => {
    expect(shouldKeepAlive({ platform: 'win32', keepAlive: true })).toBe(true)
    expect(shouldKeepAlive({ platform: 'win32', keepAlive: false })).toBe(false)
  })

  it('treats Linux the same as Windows', () => {
    expect(shouldKeepAlive({ platform: 'linux', keepAlive: true })).toBe(true)
    expect(shouldKeepAlive({ platform: 'linux', keepAlive: false })).toBe(false)
  })

  // The rule most likely to be "simplified" away later by someone who has not read the spec:
  // macOS apps do not exit when their last window closes, and Argus already behaved that way
  // before this increment existed. The setting governs whether routines keep firing there, not
  // whether the process survives.
  it('keeps macOS alive with the setting OFF, preserving the platform convention', () => {
    expect(shouldKeepAlive({ platform: 'darwin', keepAlive: false })).toBe(true)
    expect(shouldKeepAlive({ platform: 'darwin', keepAlive: true })).toBe(true)
  })
})
