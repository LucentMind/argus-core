import { describe, it, expect } from 'vitest'
import { BASE_PERSONA, composePersona, CONTRIBUTE_BACK_NUDGE } from '../persona'
import { CaseSession } from '../session'

describe('BASE_PERSONA', () => {
  it('is domain-neutral (no navigation/DLT wording)', () => {
    expect(BASE_PERSONA).not.toMatch(/navigation|DLT|logcat|argus-parse|argus-trace/i)
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

describe('CONTRIBUTE_BACK_NUDGE', () => {
  it('points at write_proposal and forbids self-applying', () => {
    expect(CONTRIBUTE_BACK_NUDGE).toContain('mcp__argus__write_proposal')
    expect(CONTRIBUTE_BACK_NUDGE).toMatch(/inert/i)
    expect(CONTRIBUTE_BACK_NUDGE).toMatch(/never apply/i)
  })
})

describe('CaseSession persona wiring', () => {
  it('injects pack fragments into the system prompt append', () => {
    let captured: any
    const fakeQuery = (args: any) => {
      captured = args
      return { async *[Symbol.asyncIterator]() {}, interrupt: async () => {} } as any
    }
    // Minimal deps: only fields read before the first prompt matter for systemPrompt assembly.
    new CaseSession({
      db: { prepare: () => ({ get: () => undefined, all: () => [], run: () => {} }) } as any,
      argusHome: '/tmp/argus',
      caseId: 1,
      caseSlug: 'demo',
      sessionId: 1,
      workspaceRoots: [],
      skillsRoots: [],
      emit: () => {},
      createQuery: fakeQuery as any,
      personaFragments: ['NAV TRACE RULES']
    } as any)
    const append = captured.options.systemPrompt.append as string
    expect(append).toContain('NAV TRACE RULES')
    expect(append).toContain('CITATIONS') // base still present
  })
})
