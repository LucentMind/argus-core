import { describe, it, expect } from 'vitest'
import { buildJudgePrompt, parseJudgeVerdict } from '../src/judge'
import type { DistillEvalItem } from '../../../app/src/shared/distillEval'

const REJECTED: DistillEvalItem = {
  type: 'skill-new', target: 'dlt-timing', title: 'DLT timing analysis',
  outcome: 'rejected', rejectReason: 'overgeneric', rejectNote: 'no concrete steps'
}
const ACCEPTED: DistillEvalItem = {
  type: 'memory-append', target: 'acme-quirks', title: 'ACME quirk', outcome: 'accepted'
}

describe('buildJudgePrompt', () => {
  it('rejected item: names the tag, the note, and both outputs', () => {
    const p = buildJudgePrompt(REJECTED, 'OLD RAW', 'NEW RAW')
    expect(p).toContain('overgeneric')
    expect(p).toContain('no concrete steps')
    expect(p).toContain('OLD RAW')
    expect(p).toContain('NEW RAW')
    expect(p).toContain('opposite failure')
  })
  it('accepted item: asks whether an equivalent item survives', () => {
    const p = buildJudgePrompt(ACCEPTED, 'OLD RAW', 'NEW RAW')
    expect(p).toContain('equivalent')
    expect(p).toContain('acme-quirks')
  })
})

describe('parseJudgeVerdict', () => {
  it('parses a single json fence', () => {
    const v = parseJudgeVerdict('text\n```json\n{"verdict": "improved", "reason": "specific now"}\n```')
    expect(v).toEqual({ verdict: 'improved', reason: 'specific now' })
  })
  it('throws on unknown verdicts and missing fences', () => {
    expect(() => parseJudgeVerdict('```json\n{"verdict": "meh", "reason": "r"}\n```')).toThrow()
    expect(() => parseJudgeVerdict('no fence')).toThrow()
  })
})
