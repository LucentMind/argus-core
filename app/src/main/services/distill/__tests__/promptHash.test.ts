import { describe, it, expect } from 'vitest'
import { caseDistillPromptHash } from '../promptHash'
import { CASE_DISTILL_CONTRACT } from '../contract'

describe('caseDistillPromptHash', () => {
  it('is stable across calls and 12 hex chars', () => {
    const h = caseDistillPromptHash()
    expect(h).toBe(caseDistillPromptHash())
    expect(h).toMatch(/^[0-9a-f]{12}$/)
  })

  it('changes when any resolved part changes, and matches default when resolver returns defaults', () => {
    const identity = (id: string): string =>
      id === 'headless.case-distill.contract' ? CASE_DISTILL_CONTRACT : `DEFAULT:${id}`
    // A resolver that returns the shipped contract but altered sections differs from default:
    expect(caseDistillPromptHash(identity)).not.toBe(caseDistillPromptHash())
    const overridden = (id: string): string =>
      id === 'headless.case-distill.contract' ? 'NEW CONTRACT' : identity(id)
    expect(caseDistillPromptHash(overridden)).not.toBe(caseDistillPromptHash(identity))
  })
})
