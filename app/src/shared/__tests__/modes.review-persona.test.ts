import { describe, expect, it } from 'vitest'
import { MODES } from '../modes'

describe('REVIEW_PERSONA citation guidance', () => {
  const persona = MODES.review.personaFragment

  it('no longer tells the agent to use the directory basename', () => {
    expect(persona).not.toMatch(/directory.s basename/i)
  })

  it('warns that the worktree directory name is NOT the repo name', () => {
    expect(persona).toMatch(/NOT the name of the worktree directory/)
  })

  it('the persona owns the dedup rule the run turn dropped', () => {
    expect(MODES.review.personaFragment).toMatch(/merge (them|those) into one finding/i)
  })
})
