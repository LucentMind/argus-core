import { describe, it, expect } from 'vitest'
import { NEUTRAL_PERSONA, TRIAGE_FRAGMENT } from '../persona'

describe('persona — the causal chain', () => {
  it('tells the triage agent to record hypotheses, promote them and link causes', () => {
    expect(TRIAGE_FRAGMENT).toContain('mcp__argus__append_finding status: hypothesis')
    expect(TRIAGE_FRAGMENT).toContain('mcp__argus__update_finding status: confirmed')
    expect(TRIAGE_FRAGMENT).toContain('supersedes: <old id>')
    expect(TRIAGE_FRAGMENT).toContain('caused_by')
  })
  it('tells every mode to update a finding rather than append a corrected one, and to keep human chain edits', () => {
    expect(NEUTRAL_PERSONA).toContain('mcp__argus__update_finding')
    expect(NEUTRAL_PERSONA).toContain('supersedes: <old id>')
    expect(NEUTRAL_PERSONA).toContain('whose claim still stands')
    expect(NEUTRAL_PERSONA).toContain("set a finding's role or cause")
  })
  it('keeps status out of the summary and actions out of findings', () => {
    expect(TRIAGE_FRAGMENT).toContain('never a CONFIRMED or HYPOTHESIS prefix')
    expect(NEUTRAL_PERSONA).toContain('under 200 characters')
    expect(NEUTRAL_PERSONA).toContain('A finding is a claim about the defect')
  })
})
