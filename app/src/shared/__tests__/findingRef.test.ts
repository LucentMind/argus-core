import { describe, it, expect } from 'vitest'
import { escapeFindingMarkers, findingIdFromToolOutput } from '../findingRef'

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

describe('escapeFindingMarkers', () => {
  it('rewrites a finding marker in model-written text so it cannot split findings.md', () => {
    expect(escapeFindingMarkers('see <!-- finding:4 --> above')).toBe(
      'see <!-- finding-ref:4 --> above'
    )
    expect(escapeFindingMarkers('<!--finding:12-->\n<!--  finding:3   -->')).toBe(
      '<!-- finding-ref:12 -->\n<!-- finding-ref:3 -->'
    )
  })
  it('leaves other text, other comments and the escaped form alone', () => {
    expect(escapeFindingMarkers('<!-- note --> finding:4 <!-- finding-ref:4 -->')).toBe(
      '<!-- note --> finding:4 <!-- finding-ref:4 -->'
    )
  })
})
