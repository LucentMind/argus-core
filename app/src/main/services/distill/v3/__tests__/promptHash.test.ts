import { describe, it, expect } from 'vitest'
import { stagePromptHash, caseDistillPipelineHash } from '../promptHash'
import { caseDistillPromptHash } from '../../promptHash'

describe('v3 prompt hashes', () => {
  it('are stable, 12 hex, and distinct per stage', () => {
    const hs = ['dossier', 'summary', 'candidates', 'materialize'].map((s) =>
      stagePromptHash(s as never)
    )
    for (const h of hs) expect(h).toMatch(/^[0-9a-f]{12}$/)
    expect(new Set(hs).size).toBe(4)
    expect(stagePromptHash('dossier')).toBe(stagePromptHash('dossier'))
  })
  it('composed hash changes when any stage contract changes, and differs from the v2 hash', () => {
    const base = caseDistillPipelineHash()
    const changed = caseDistillPipelineHash((id) =>
      id === 'headless.case-distill.summary.contract' ? 'X' : (undefined as never)
    )
    expect(changed).not.toBe(base)
    expect(base).not.toBe(caseDistillPromptHash())
  })
})
