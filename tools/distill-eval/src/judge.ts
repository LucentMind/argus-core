import type { DistillEvalItem } from '../../../app/src/shared/distillEval'

export type JudgeVerdictKind = 'improved' | 'unchanged' | 'regressed' | 'needs-human'
export interface JudgeVerdict {
  verdict: JudgeVerdictKind
  reason: string
}
const KINDS: JudgeVerdictKind[] = ['improved', 'unchanged', 'regressed', 'needs-human']

export function buildJudgePrompt(
  item: DistillEvalItem,
  baselineRaw: string,
  candidateRaw: string
): string {
  const question =
    item.outcome === 'rejected'
      ? [
          `In the OLD output, the item "${item.title}" (${item.type} → ${item.target}) was rejected by a human reviewer as "${item.rejectReason ?? 'unspecified'}"${item.rejectNote ? ` with the note: "${item.rejectNote}"` : ''}.`,
          item.rejectReason === 'overfit'
            ? "overfit means: too tied to one case's specifics to reuse. The opposite failure is being too generic."
            : item.rejectReason === 'overgeneric'
              ? "overgeneric means: too vague to be actionable. The opposite failure is being too case-specific."
              : '',
          `Question: does the NEW output fix that failure for this item (or drop the item entirely, which also counts as fixed) WITHOUT introducing the opposite failure?`,
          `improved = failure fixed; unchanged = same failure present; regressed = failure worse or the opposite failure introduced; needs-human = you cannot tell.`
        ]
          .filter(Boolean)
          .join('\n')
      : item.editedContent
        ? // Accepted-but-edited: the human's text is the gold standard, not the agent's draft.
          // Grading against the draft would score a candidate DOWN for producing exactly what
          // the reviewer had to hand-write.
          [
            `In the OLD output, the item "${item.title}" (${item.type} → ${item.target}) was accepted, but the human reviewer EDITED it before accepting. The human's accepted version is the gold standard:`,
            '```\n' + item.editedContent + '\n```',
            `Question: does the NEW output's equivalent item move CLOSER to the human's accepted version than the old draft did (or match it)?`,
            `improved = closer to the human version; unchanged = same distance; regressed = further away or item lost; needs-human = you cannot tell.`
          ].join('\n')
        : [
            `In the OLD output, the item "${item.title}" (${item.type} → ${item.target}) was ACCEPTED by a human reviewer — it is a positive control.`,
            `Question: does the NEW output still contain an equivalent item (same target or clearly the same knowledge, comparable or better quality)?`,
            `improved = equivalent and clearly better; unchanged = equivalent; regressed = lost or clearly degraded; needs-human = you cannot tell.`
          ].join('\n')
  return [
    'You are judging whether a revised knowledge-distillation prompt improved one specific output item. Be strict; when in doubt answer needs-human.',
    question,
    '# OLD output (produced by the baseline prompt)',
    baselineRaw,
    '# NEW output (produced by the candidate prompt)',
    candidateRaw,
    'Return exactly one fenced ```json block: {"verdict": "improved|unchanged|regressed|needs-human", "reason": "<one sentence>"}'
  ].join('\n\n')
}

export function parseJudgeVerdict(text: string): JudgeVerdict {
  const fences = [...text.matchAll(/```json\s*\n([\s\S]*?)\n```/g)]
  if (fences.length !== 1) throw new Error(`expected exactly 1 json fence, got ${fences.length}`)
  const obj = JSON.parse(fences[0][1]) as { verdict?: string; reason?: string }
  if (!KINDS.includes(obj.verdict as JudgeVerdictKind)) {
    throw new Error(`unknown verdict ${JSON.stringify(obj.verdict)}`)
  }
  return { verdict: obj.verdict as JudgeVerdictKind, reason: String(obj.reason ?? '') }
}
