import { describe, it, expect } from 'vitest'
import { isApiCompatible, osOf, archOf, platformMatchesHost, describeHost } from '../compat'

describe('isApiCompatible', () => {
  it('accepts a caret range that includes the current API (^1)', () => {
    expect(isApiCompatible('^1')).toBe(true)
    expect(isApiCompatible('>=1')).toBe(true)
    expect(isApiCompatible('1.x')).toBe(true)
  })
  it('rejects a range that excludes the current API', () => {
    expect(isApiCompatible('^2')).toBe(false)
    expect(isApiCompatible('>=2')).toBe(false)
  })
  it('rejects a malformed range', () => {
    expect(isApiCompatible('not-a-range')).toBe(false)
  })
})

describe('osOf / archOf', () => {
  it('maps known os/arch tokens', () => {
    expect(osOf('mac-arm64')).toBe('darwin')
    expect(osOf('win-x64')).toBe('win32')
    expect(osOf('linux-x64')).toBe('linux')
    expect(archOf('mac-arm64')).toBe('arm64')
    expect(archOf('win-x64')).toBe('x64')
  })
  it('returns null on unknown or malformed', () => {
    expect(osOf('bsd-x64')).toBeNull()
    expect(archOf('win-riscv')).toBeNull()
    expect(osOf('macarm64')).toBeNull()
  })
})

describe('platformMatchesHost', () => {
  const host = { platform: 'win32', arch: 'x64' }
  it('matches host os AND arch', () => {
    expect(platformMatchesHost('win-x64', host)).toBe(true)
  })
  it('rejects arch mismatch even when os matches', () => {
    expect(platformMatchesHost('win-arm64', host)).toBe(false)
  })
  it('rejects os mismatch', () => {
    expect(platformMatchesHost('mac-x64', host)).toBe(false)
  })
  it('rejects undefined / unknown', () => {
    expect(platformMatchesHost(undefined, host)).toBe(false)
    expect(platformMatchesHost('bsd-x64', host)).toBe(false)
  })
})

describe('describeHost', () => {
  it('renders host as an <os>-<arch> pack string', () => {
    expect(describeHost({ platform: 'darwin', arch: 'arm64' })).toBe('mac-arm64')
    expect(describeHost({ platform: 'win32', arch: 'x64' })).toBe('win-x64')
  })
  it('falls back to raw tokens for an unmapped host', () => {
    expect(describeHost({ platform: 'sunos', arch: 'sparc' })).toBe('sunos-sparc')
  })
})
