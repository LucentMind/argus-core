import { describe, it, expect } from 'vitest'
import { replayCase, contractResolver } from '../src/replay'
import { caseDistillPromptHash } from '../../../app/src/main/services/distill/promptHash'
import { line } from './fixtures'

describe('replayCase', () => {
  it('reuses the stored output without a model call when hashes match', async () => {
    let calls = 0
    const r = await replayCase(line({ promptHash: caseDistillPromptHash() }), async () => {
      calls++
      return ''
    })
    expect(calls).toBe(0)
    expect(r.reused).toBe(true)
    expect(r.parsed?.summary?.signature).toBe('s')
  })

  it('runs the candidate prompt when hashes differ and reports a parse failure', async () => {
    const r = await replayCase(line(), async () => 'no fence here')
    expect(r.reused).toBe(false)
    expect(r.parsed).toBeNull()
    expect(r.parseError).toMatch(/json fence/)
  })

  it('contractResolver overrides only the contract id and changes the candidate hash', () => {
    const resolve = contractResolver('NEW CONTRACT')!
    expect(resolve('headless.case-distill.contract')).toBe('NEW CONTRACT')
    expect(resolve('headless.case-distill.section.case')).toBe('# Case')
    expect(caseDistillPromptHash(resolve)).not.toBe(caseDistillPromptHash())
    expect(contractResolver(null)).toBeUndefined()
  })
})
