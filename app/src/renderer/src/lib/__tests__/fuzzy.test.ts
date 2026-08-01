import { describe, expect, it } from 'vitest'
import { fuzzyMatch } from '../fuzzy'

describe('fuzzyMatch', () => {
  it('matches everything on an empty query, scoring nothing', () => {
    expect(fuzzyMatch('', 'jira-fields.md')).toEqual({ score: 0, positions: [] })
  })

  it('returns null when a character is missing', () => {
    expect(fuzzyMatch('zq', 'jira-fields.md')).toBeNull()
  })

  it('is case-insensitive and reports positions into the target', () => {
    expect(fuzzyMatch('JF', 'jira-fields.md')).toEqual({
      score: expect.any(Number),
      positions: [0, 5]
    })
  })

  it('prefers word-boundary hits over interior ones', () => {
    const boundary = fuzzyMatch('jf', 'jira-fields.md')!
    const interior = fuzzyMatch('jf', 'jiffy-notes.md')!
    expect(boundary.score).toBeGreaterThan(interior.score)
  })

  it('prefers a consecutive run over a scattered one', () => {
    // The scattered target deliberately puts NO separator before the later characters. The
    // boundary bonus is larger than the run bonus, so `j-i-r-a` would out-score `jira` — every
    // one of its characters starts a word. That is the intended weighting, not a bug: a hyphen
    // -separated acronym match is genuinely a good hit.
    const run = fuzzyMatch('jira', 'jira-fields.md')!
    const scattered = fuzzyMatch('jira', 'jxixrxa.md')!
    expect(run.score).toBeGreaterThan(scattered.score)
  })

  it('prefers the earlier of two otherwise equal matches', () => {
    const early = fuzzyMatch('note', 'notes.md')!
    const late = fuzzyMatch('note', 'zzzz-notes.md')!
    expect(early.score).toBeGreaterThan(late.score)
  })

  it('takes the first legal subsequence rather than backtracking', () => {
    // 'ab' against 'a-x-a-b': the greedy walk pairs the FIRST 'a' with the later 'b'.
    // Documented so a later "optimal match" rewrite is a deliberate change, not a surprise.
    expect(fuzzyMatch('ab', 'a-x-a-b')!.positions).toEqual([0, 6])
  })
})
