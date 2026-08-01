import { describe, it, expect } from 'vitest'
import { PHASE_ORDER, PHASE_WORD, PHASE_COLOR } from '../casePhase'

describe('phase vocabulary', () => {
  it('covers every phase in both maps', () => {
    for (const p of PHASE_ORDER) {
      expect(PHASE_WORD[p]).toBeTruthy()
      expect(PHASE_COLOR[p]).toMatch(/^text-/)
    }
  })

  it('orders phases along the workflow', () => {
    expect(PHASE_ORDER).toEqual([
      'open',
      'analyzing',
      'pr-created',
      'reviewing',
      'rca-drafted',
      'closed'
    ])
  })

  it('spells the multi-word phases out for humans', () => {
    expect(PHASE_WORD['pr-created']).toBe('PR created')
    expect(PHASE_WORD['rca-drafted']).toBe('RCA drafted')
  })
})
