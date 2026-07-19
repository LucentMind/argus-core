import { describe, it, expect } from 'vitest'
import { runCaseDistill } from '../caseDistiller'
import { DistillParseError } from '../contract'
import type { CaseDistillInput } from '../../../../shared/distill'

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

describe('runCaseDistill', () => {
  it('returns parsed output on valid JSON', async () => {
    const run = await runCaseDistill(INPUT, async () => '```json\n{}\n```')
    expect(run.output).toEqual({})
    expect(run.raw).toContain('```json')
  })

  it('throws DistillParseError with raw preserved on invalid output', async () => {
    await expect(runCaseDistill(INPUT, async () => 'no json here')).rejects.toThrow(
      DistillParseError
    )
  })

  it('passes the built prompt to the injected runner and parses its text', async () => {
    let seen = ''
    const run = async (prompt: string): Promise<string> => {
      seen = prompt
      return '```json\n{"memoryAppends":[{"topic":"a-topic","content":"c"}]}\n```'
    }
    const result = await runCaseDistill(INPUT, run)
    expect(seen).toContain('# Case')
    expect(result.output.memoryAppends).toHaveLength(1)
    expect(result.raw).toContain('```json')
  })
})
