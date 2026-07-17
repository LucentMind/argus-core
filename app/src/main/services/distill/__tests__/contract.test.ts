import { describe, it, expect } from 'vitest'
import {
  buildCaseDistillPrompt,
  parseCaseDistillOutput,
  DistillParseError,
  CASE_DISTILL_CONTRACT
} from '../contract'
import type { CaseDistillInput } from '../../../../shared/distill'

const INPUT: CaseDistillInput = {
  caseMeta: {
    slug: 'c1',
    title: 'T',
    jiraKey: 'AB-1',
    resolution: 'solved',
    tags: [],
    createdAt: 'a',
    closedAt: 'b'
  },
  findings: [{ summary: 'F1', reviewState: 'accepted', body: 'body1' }],
  evidence: [{ relPath: 'evidence/a.log', artifactType: 'text', size: 10 }],
  sessionTitles: ['First look'],
  memoryIndex: '- [dlt-timing](dlt-timing.md) — entry',
  skillsIndex: [{ name: 'analyze-dlt', description: 'd' }],
  referencesIndex: [{ name: 'runbook', summary: 's' }],
  alreadyCaptured: {
    proposals: [{ type: 'recipe', target: 'dlt-cmds', title: 'Cmds', state: 'rejected' }],
    memoryWrites: [{ topic: 'dlt-timing', indexEntry: 'entry' }]
  }
}

describe('prompt builder', () => {
  it('includes contract, annotated findings, and already-captured section', () => {
    const p = buildCaseDistillPrompt(INPUT)
    expect(p).toContain(CASE_DISTILL_CONTRACT)
    expect(p).toContain('[accepted] F1')
    expect(p).toContain('Knowledge already captured')
    expect(p).toContain('dlt-cmds')
    expect(p).toContain('dlt-timing')
  })
})

describe('parseCaseDistillOutput', () => {
  const fence = (s: string): string => 'preamble\n```json\n' + s + '\n```\n'

  it('parses a full valid document', () => {
    const out = parseCaseDistillOutput(
      fence(
        JSON.stringify({
          summary: { signature: 's', symptoms: 'sy', rootCause: 'rc', fix: 'f', keywords: ['k'] },
          memoryAppends: [{ topic: 'dlt-timing', content: 'c' }],
          proposals: [{ type: 'skill-edit', target: 'analyze-dlt', title: 't', content: 'c' }]
        })
      )
    )
    expect(out.summary?.signature).toBe('s')
    expect(out.memoryAppends).toHaveLength(1)
  })

  it('accepts an empty object (nothing to distill)', () => {
    expect(parseCaseDistillOutput(fence('{}'))).toEqual({})
  })

  it.each([
    ['no fence', 'just text'],
    ['two fences', fence('{}') + fence('{}')],
    ['bad json', fence('{nope')],
    ['unknown key', fence('{"surprise": 1}')],
    [
      'bad proposal type',
      fence('{"proposals":[{"type":"memory-append","target":"t","title":"t","content":"c"}]}')
    ],
    ['summary missing field', fence('{"summary":{"signature":"s"}}')],
    ['empty topic', fence('{"memoryAppends":[{"topic":"","content":"c"}]}')],
    ['null memoryAppends entry', fence('{"memoryAppends":[null]}')],
    ['null proposal entry', fence('{"proposals":[null]}')]
  ])('rejects %s with DistillParseError carrying raw', (_name, text) => {
    expect(() => parseCaseDistillOutput(text)).toThrow(DistillParseError)
    try {
      parseCaseDistillOutput(text)
    } catch (e) {
      expect((e as DistillParseError).raw).toBe(text)
    }
  })
})
