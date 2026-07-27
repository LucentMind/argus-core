import { describe, it, expect } from 'vitest'
import { firstCitation } from '../citations'

describe('firstCitation', () => {
  it('extracts path and first line from a single-line citation', () => {
    expect(firstCitation('The guard is inverted [argus-core/app/src/main/x.ts:42].')).toEqual({
      path: 'argus-core/app/src/main/x.ts',
      line: 42
    })
  })

  it('takes the range start for a range citation', () => {
    expect(firstCitation('see [repo/a.ts:10-14]')).toEqual({ path: 'repo/a.ts', line: 10 })
  })

  it('takes the first line of a disjoint list', () => {
    expect(firstCitation('see [repo/a.ts:43,56]')).toEqual({ path: 'repo/a.ts', line: 43 })
  })

  it('returns the FIRST citation when several appear', () => {
    expect(firstCitation('[repo/a.ts:1] and later [repo/b.ts:9]')).toEqual({
      path: 'repo/a.ts',
      line: 1
    })
  })

  it('ignores prose brackets that are not citations', () => {
    expect(firstCitation('the [nav-sdk] logger and [IgnoredRoute(x)] both fired')).toBeNull()
  })

  it('ignores a markdown link', () => {
    expect(firstCitation('[repo/a.ts:1](http://x)')).toBeNull()
  })

  it('returns null for markdown with no citation', () => {
    expect(firstCitation('no citation here')).toBeNull()
  })
})
