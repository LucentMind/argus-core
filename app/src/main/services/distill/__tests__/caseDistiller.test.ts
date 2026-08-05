import { describe, it, expect } from 'vitest'
import { runCaseDistill } from '../caseDistiller'
import { DistillParseError } from '../contract'
import type { CaseDistillInput } from '../../../../shared/distill'

const INPUT: CaseDistillInput = {
  caseMeta: {
    slug: 'c1',
    title: 'T',
    jiraKey: null,
    status: 'closed',
    resolution: 'solved',
    tags: [],
    createdAt: 'a',
    closedAt: 'b'
  },
  findings: [],
  evidence: [],
  sessionTitles: [],
  skillsIndex: [],
  referencesIndex: [],
  rcaStructure: null,
  alreadyCaptured: { proposals: [] }
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
      return '```json\n{"proposals":[{"type":"recipe","target":"a-topic","title":"t","content":"c"}]}\n```'
    }
    const result = await runCaseDistill(INPUT, run)
    expect(seen).toContain('# Case')
    expect(result.output.proposals).toHaveLength(1)
    expect(result.raw).toContain('```json')
  })

  it('forwards the abort signal to the runner', async () => {
    const seen: (AbortSignal | undefined)[] = []
    const ac = new AbortController()
    await runCaseDistill(
      INPUT,
      async (_p, o) => {
        seen.push(o?.signal)
        return '```json\n{}\n```'
      },
      undefined,
      ac.signal
    )
    expect(seen[0]).toBe(ac.signal)
  })
})
