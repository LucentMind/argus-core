import { describe, it, expect } from 'vitest'
import type { DatabaseSync } from 'node:sqlite'
import { BASE_PERSONA, NEUTRAL_PERSONA, composePersona, CONTRIBUTE_BACK_NUDGE } from '../persona'
import { CaseSession } from '../session'
import { createClaudeDriver, type CreateQueryFn } from '../drivers/claude'
import { createDetection } from '../../packs/detection'

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
  // composePersona no longer prepends a hardcoded base — the fragments passed in ARE
  // the whole ordered composition (assembleMode decides that order for real sessions).
  // These tests exercise composePersona in isolation with NEUTRAL_PERSONA supplied
  // explicitly, the way a caller must.
  it('returns the fragments joined when there is no append', () => {
    expect(composePersona([NEUTRAL_PERSONA])).toBe(NEUTRAL_PERSONA)
  })
  it('joins fragments in order', () => {
    const out = composePersona(['FRAG-A', 'FRAG-B'])
    expect(out).toBe('FRAG-A\n\nFRAG-B')
  })
  it('appends the per-session personaAppend last', () => {
    expect(composePersona(['FRAG'], 'SESSION')).toBe('FRAG\n\nSESSION')
  })
  it('drops empty fragments and an empty append', () => {
    expect(composePersona(['', 'FRAG'], '')).toBe('FRAG')
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
    let captured: Parameters<CreateQueryFn>[0] | undefined
    const fakeQuery: CreateQueryFn = (args) => {
      captured = args
      return {
        async *[Symbol.asyncIterator]() {
          // the session never consumes messages in this test
        },
        interrupt: async () => undefined
      }
    }
    // Minimal deps: only fields read before the first prompt matter for systemPrompt assembly.
    new CaseSession({
      db: {
        prepare: () => ({ get: () => undefined, all: () => [], run: () => undefined })
      } as unknown as DatabaseSync,
      argusHome: '/tmp/argus',
      detection: createDetection(),
      caseId: 1,
      caseSlug: 'demo',
      sessionId: 1,
      workspaceRoots: [],
      skillsRoots: [],
      emit: () => undefined,
      driver: createClaudeDriver(fakeQuery),
      resumeCursor: null,
      // Real sessions get their fragment order from assembleMode (mode identity, then
      // NEUTRAL_PERSONA, then packs); include NEUTRAL_PERSONA here to match that shape —
      // composePersona itself no longer injects it.
      personaFragments: ['NAV TRACE RULES', NEUTRAL_PERSONA]
    })
    const append = (captured!.options.systemPrompt as { append: string }).append
    expect(append).toContain('NAV TRACE RULES')
    expect(append).toContain('CITATIONS') // base still present
  })
})
