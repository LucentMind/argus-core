import { describe, it, expect } from 'vitest'
import {
  ARTIFACTS_PREFIX,
  dirForMode,
  scopeOfRelPath,
  sidecarRelPath
} from '../evidenceScope'

describe('dirForMode', () => {
  it('maps each mode to its directory', () => {
    expect(dirForMode('investigation')).toBe('evidence')
    expect(dirForMode('review')).toBe('artifacts')
  })
})

describe('scopeOfRelPath', () => {
  it('reads review off the artifacts prefix', () => {
    expect(scopeOfRelPath('artifacts/ci-5-verify.log')).toBe('review')
    expect(scopeOfRelPath('artifacts/.derived/ci-5-verify.log.txt')).toBe('review')
  })

  it('treats everything else as investigation', () => {
    expect(scopeOfRelPath('evidence/ticket.md')).toBe('investigation')
    expect(scopeOfRelPath('evidence/sub/deep/nested.log')).toBe('investigation')
  })

  // A directory merely NAMED like the prefix must not count: only the first segment decides.
  it('does not match a nested directory called artifacts', () => {
    expect(scopeOfRelPath('evidence/artifacts/x.log')).toBe('investigation')
  })

  it('exports the prefix it matches on', () => {
    expect(ARTIFACTS_PREFIX).toBe('artifacts/')
  })
})

describe('sidecarRelPath', () => {
  it('puts the sidecar under the same top directory', () => {
    expect(sidecarRelPath('evidence/ticket.md')).toBe('evidence/.meta/ticket.md.json')
    expect(sidecarRelPath('artifacts/ci-5.log')).toBe('artifacts/.meta/ci-5.log.json')
  })

  it('preserves nesting below the top directory', () => {
    expect(sidecarRelPath('evidence/.derived/a.txt')).toBe('evidence/.meta/.derived/a.txt.json')
  })

  it('rejects a path with no directory segment', () => {
    expect(() => sidecarRelPath('loose.md')).toThrow(/top-level directory/i)
  })
})
