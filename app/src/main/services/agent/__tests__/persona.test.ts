import { describe, it, expect } from 'vitest'
import { BASE_PERSONA, composePersona } from '../persona'

describe('BASE_PERSONA', () => {
  it('is domain-neutral (no navigation/BINLOG wording)', () => {
    expect(BASE_PERSONA).not.toMatch(/navigation|BINLOG|applog|sample-parse|sample-trace/i)
  })
  it('keeps the generic working rules', () => {
    expect(BASE_PERSONA).toMatch(/CITATIONS/)
    expect(BASE_PERSONA).toMatch(/FINDINGS/)
    expect(BASE_PERSONA).toMatch(/WORKSPACES/)
    expect(BASE_PERSONA).toMatch(/HITL/)
  })
})

describe('composePersona', () => {
  it('returns base only when there are no fragments or append', () => {
    expect(composePersona([])).toBe(BASE_PERSONA)
  })
  it('appends fragments after the base, in order', () => {
    const out = composePersona(['FRAG-A', 'FRAG-B'])
    expect(out).toBe(`${BASE_PERSONA}\n\nFRAG-A\n\nFRAG-B`)
  })
  it('appends the per-session personaAppend last', () => {
    expect(composePersona(['FRAG'], 'SESSION')).toBe(`${BASE_PERSONA}\n\nFRAG\n\nSESSION`)
  })
  it('drops empty fragments and an empty append', () => {
    expect(composePersona(['', 'FRAG'], '')).toBe(`${BASE_PERSONA}\n\nFRAG`)
  })
})
