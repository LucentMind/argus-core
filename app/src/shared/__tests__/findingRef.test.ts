import { describe, it, expect } from 'vitest'
import { findingIdFromToolOutput } from '../findingRef'

describe('findingIdFromToolOutput', () => {
  it('reads the id the append_finding result names', () => {
    expect(findingIdFromToolOutput('finding appended as #42')).toBe(42)
  })
  it('tolerates an overridden wording as long as it keeps #<id>', () => {
    expect(findingIdFromToolOutput('Recorded (#7) — now carry on')).toBe(7)
  })
  it('returns null for the old wording, an empty preview, or an error', () => {
    expect(findingIdFromToolOutput('finding appended')).toBeNull()
    expect(findingIdFromToolOutput('')).toBeNull()
    expect(findingIdFromToolOutput('append_finding — unknown layer: vibes')).toBeNull()
  })
})
