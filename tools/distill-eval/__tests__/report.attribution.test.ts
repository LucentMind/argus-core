import { describe, it, expect } from 'vitest'
import { attributionSummary } from '../src/report'

const line = (assets: unknown[]) =>
  ({
    job: {
      id: 1,
      caseSlug: 'c',
      promptHash: null,
      createdAt: 'x',
      state: 'done',
      inputSnapshot: { caseMeta: { slug: 'c' }, findings: [{ id: 7 }], evidence: [], assets },
      rawOutput: '',
      error: null
    },
    items: [],
    exportedAt: 'x',
    argusVersion: '0'
  }) as never
const A = [
  { kind: 'skill', name: 'diag', tier: null, callCount: 1, firstSeen: { sessionId: 1, turnId: null } },
  { kind: 'memory', name: 'm', tier: null, callCount: 1, firstSeen: { sessionId: 1, turnId: null } }
]

describe('attributionSummary', () => {
  it('reports skipped / error / not run / counts', () => {
    expect(attributionSummary(line(A), { attributionSkipped: 'declined' })).toBe('attribution: skipped (declined)')
    expect(attributionSummary(line([]), { attributionSkipped: 'no-assets' })).toBe('attribution: skipped (no assets)')
    expect(attributionSummary(line(A), { attributionSkipped: 'open' })).toBe('attribution: skipped (open case)')
    expect(
      attributionSummary(line(A), { attribution: { promptHash: 'a', promptChars: 1, rawOutput: '', error: 'boom' } })
    ).toBe('attribution: error — boom')
    expect(attributionSummary(line(A), undefined)).toBe('attribution: not run')
    const raw =
      '```json\n{"verdicts":[{"kind":"skill","name":"diag","applied":true,"verdict":"helped","reason":"r","cites":[{"finding":7}]}]}\n```'
    expect(
      attributionSummary(line(A), { attribution: { promptHash: 'a', promptChars: 1, rawOutput: raw } })
    ).toBe('attribution: 1 applied · 1 helped · 0 misled · 1 silent')
  })
})
