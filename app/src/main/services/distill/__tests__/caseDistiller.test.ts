import { describe, it, expect } from 'vitest'
import { runCaseDistill } from '../caseDistiller'
import { DistillParseError } from '../contract'
import type { CaseDistillInput } from '../../../../shared/distill'
import type { CreateQueryFn } from '../../agent/drivers/claude'

const INPUT: CaseDistillInput = {
  caseMeta: {
    slug: 'c1',
    title: 'T',
    jiraKey: null,
    resolution: 'solved',
    tags: [],
    createdAt: 'a',
    closedAt: 'b'
  },
  findings: [],
  evidence: [],
  sessionTitles: [],
  memoryIndex: '',
  skillsIndex: [],
  referencesIndex: [],
  alreadyCaptured: { proposals: [], memoryWrites: [] }
}

function fakeQuery(responseText: string): CreateQueryFn {
  return (() => {
    const iter = (async function* () {
      yield {
        type: 'assistant',
        message: { role: 'assistant', content: [{ type: 'text', text: responseText }] }
      }
      yield { type: 'result', subtype: 'success' }
    })()
    return Object.assign(iter, { interrupt: async () => undefined })
  }) as unknown as CreateQueryFn
}

describe('runCaseDistill', () => {
  it('returns parsed output on valid JSON', async () => {
    const run = await runCaseDistill(INPUT, {}, fakeQuery('```json\n{}\n```'))
    expect(run.output).toEqual({})
    expect(run.raw).toContain('```json')
  })

  it('throws DistillParseError with raw preserved on invalid output', async () => {
    await expect(runCaseDistill(INPUT, {}, fakeQuery('no json here'))).rejects.toThrow(
      DistillParseError
    )
  })
})
