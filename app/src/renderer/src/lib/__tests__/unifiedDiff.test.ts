import { describe, it, expect } from 'vitest'
import { parseUnifiedDiff } from '../unifiedDiff'

const GIT_DIFF = [
  'diff --git a/references/nav.md b/references/nav.md',
  'index 1111111..2222222 100644',
  '--- a/references/nav.md',
  '+++ b/references/nav.md',
  '@@ -3,3 +3,4 @@ heading',
  ' context line',
  '-old line',
  '+new line',
  '+added line',
  '@@ -20,1 +21,1 @@',
  '-tail old',
  '+tail new'
].join('\n')

describe('parseUnifiedDiff', () => {
  it('parses file meta, hunk offsets, and line kinds', () => {
    const segs = parseUnifiedDiff(GIT_DIFF)
    expect(segs).toEqual([
      { meta: 'a/references/nav.md b/references/nav.md' },
      {
        leftStart: 3,
        rightStart: 3,
        lines: [
          { kind: 'same', text: 'context line' },
          { kind: 'del', text: 'old line' },
          { kind: 'add', text: 'new line' },
          { kind: 'add', text: 'added line' }
        ]
      },
      {
        leftStart: 20,
        rightStart: 21,
        lines: [
          { kind: 'del', text: 'tail old' },
          { kind: 'add', text: 'tail new' }
        ]
      }
    ])
  })

  it('returns [] for non-diff text', () => {
    expect(parseUnifiedDiff('just some file content\nwith lines')).toEqual([])
    expect(parseUnifiedDiff('')).toEqual([])
  })
})
