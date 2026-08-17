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
const ACCEPTED_EDITED: DistillEvalItem = {
  type: 'skill-edit', target: 'dlt-timing', title: 'DLT timing analysis',
  outcome: 'accepted', editedContent: 'run the timing sweep BEFORE reseating the card'
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

  it('accepted-with-edit item: the human text is the gold standard, not the draft', () => {
    const p = buildJudgePrompt(ACCEPTED_EDITED, 'OLD RAW', 'NEW RAW')
    expect(p).toContain('the human reviewer EDITED it before accepting')
    expect(p).toContain('run the timing sweep BEFORE reseating the card')
    expect(p).toContain('CLOSER to the human')
    // the unedited positive-control framing must NOT leak into the edited branch:
    expect(p).not.toContain('positive control')
    expect(p).toContain('OLD RAW')
    expect(p).toContain('NEW RAW')
  })

  // Pinned byte-for-byte: the edited-gold branch (above) must not perturb the
  // plain accepted positive control, or every pre-existing corpus verdict shifts
  // for a reason that has nothing to do with the prompt under test.
  it('accepted item WITHOUT an edit: prompt is byte-identical to the pre-edited-gold wording', () => {
    expect(buildJudgePrompt(ACCEPTED, 'OLD RAW', 'NEW RAW')).toMatchInlineSnapshot(`
      "You are judging whether a revised knowledge-distillation prompt improved one specific output item. Be strict; when in doubt answer needs-human.

      In the OLD output, the item "ACME quirk" (memory-append → acme-quirks) was ACCEPTED by a human reviewer — it is a positive control.
      Question: does the NEW output still contain an equivalent item (same target or clearly the same knowledge, comparable or better quality)?
      improved = equivalent and clearly better; unchanged = equivalent; regressed = lost or clearly degraded; needs-human = you cannot tell.

      # OLD output (produced by the baseline prompt)

      OLD RAW

      # NEW output (produced by the candidate prompt)

      NEW RAW

      Return exactly one fenced \`\`\`json block: {"verdict": "improved|unchanged|regressed|needs-human", "reason": "<one sentence>"}"
    `)
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
