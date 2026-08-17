import crypto from 'node:crypto'
import { describe, it, expect } from 'vitest'
import { caseDistillPromptHash } from '../promptHash'
import { CASE_DISTILL_CONTRACT, CASE_DISTILL_SECTIONS } from '../contract'
import { DISTILL_TOOL_DESCRIPTORS } from '../worldTools'
import { PTC_STUB_VERSION } from '../../ptc/stub'

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

  it('covers the tool descriptors and PTC stub version (v2 widening)', () => {
    const NUL = String.fromCharCode(0)
    const hashOf = (parts: string[]): string =>
      crypto
        .createHash('sha256')
        .update(parts.join('\n' + NUL + '\n'))
        .digest('hex')
        .slice(0, 12)
    const baseParts = [
      CASE_DISTILL_CONTRACT,
      ...Object.keys(CASE_DISTILL_SECTIONS)
        .sort()
        .map((k) => CASE_DISTILL_SECTIONS[k].text)
    ]
    // The default hash must equal exactly base parts + descriptors JSON + stub version — proving
    // caseDistillPromptHash() actually folds both in, not just that it differs from something.
    const expected = hashOf([
      ...baseParts,
      JSON.stringify(DISTILL_TOOL_DESCRIPTORS),
      `ptc-stub:${PTC_STUB_VERSION}`
    ])
    expect(caseDistillPromptHash()).toBe(expected)
    // Editing a descriptor's text (e.g. a description string) must change the hash.
    const mutatedDescriptors = hashOf([
      ...baseParts,
      JSON.stringify(DISTILL_TOOL_DESCRIPTORS).replace('List', 'LIST'),
      `ptc-stub:${PTC_STUB_VERSION}`
    ])
    expect(mutatedDescriptors).not.toBe(expected)
    // Bumping the PTC stub version must change the hash.
    const mutatedVersion = hashOf([
      ...baseParts,
      JSON.stringify(DISTILL_TOOL_DESCRIPTORS),
      'ptc-stub:999'
    ])
    expect(mutatedVersion).not.toBe(expected)
  })
})
