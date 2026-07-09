import { describe, it, expect } from 'vitest'
import { linkifyCitations } from '../citations'

describe('linkifyCitations', () => {
  it('rewrites evidence citations into cite:// links', () => {
    expect(linkifyCitations('Crash at [evidence/applog.txt:812] confirmed.')).toBe(
      'Crash at [evidence/applog.txt:812](cite://evidence/applog.txt?line=812) confirmed.'
    )
  })
  it('leaves normal links and non-citation brackets alone', () => {
    const s = 'See [docs](https://x.y) and [not a citation] and [foo.txt:12].'
    expect(linkifyCitations(s)).toBe(s)
  })
})
