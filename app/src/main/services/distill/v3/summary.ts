import type { CaseDistillInput, CaseDistillSummary } from '../../../../shared/distill'
import type { Dossier } from '../../../../shared/distillV3'
import type { PromptTextSpecs } from '../../../../shared/promptSpec'
import { DistillParseError } from '../contract'

/** Stage 2a: is this case recurrence-relevant, and what is its canonical summary? Case-scoped —
 *  identifiers are wanted here. Tool-less; sees only the dossier and the case meta. */
export const SUMMARY_CONTRACT = `You are writing the canonical case summary for a root-cause-analysis toolkit, from an evidence dossier prepared by a previous pass. The summary is CASE-SCOPED: ticket keys, product and component names, versions and identifiers are wanted — a future agent will match a new incident against it.

Rules:
1. SUMMARY ONLY IF RECURRENCE-RELEVANT: emit "summary" only when this case could recur or attract near-duplicate defects. Otherwise return {"summary": null}.
2. ANCHOR ON THE DOSSIER: "rootCause" and "signature" come from dossier.root_cause; "symptoms" from the diagnostic path's observations and the case title; "fix" from dossier.confirmed_fix. Never add a cause or fix the dossier does not establish.
3. STATUS AND RESOLUTION: open ⇒ "fix" MUST state that no fix is confirmed yet and the summary must not imply the case was resolved; wont-fix ⇒ "fix" states it was intentionally not fixed (and why, if the dossier says); forwarded ⇒ "fix" states root-causing moved elsewhere; duplicate / rejected / not-reproducible ⇒ almost always {"summary": null}. If dossier.scope.settled is false and dossier.root_cause is null, return {"summary": null}.
4. OUTPUT: exactly one fenced \`\`\`json block containing {"summary": {signature, symptoms, rootCause, fix, keywords[]} | null}. "signature" is ONE line. keywords are 3–8 short search terms. No other keys, no commentary inside the block.`

export const SUMMARY_SECTIONS: PromptTextSpecs = {
  case: { title: 'Summary section — case metadata', text: '# Case' },
  dossier: { title: 'Summary section — dossier', text: '# Dossier' },
  'output-nudge': {
    title: 'Summary — closing output instruction',
    text: 'Return exactly one fenced ```json block now.'
  }
}

export function buildSummaryPrompt(
  input: CaseDistillInput,
  dossier: Dossier,
  resolve?: (id: string) => string
): string {
  const m = input.caseMeta
  const sec = (key: string): string =>
    resolve
      ? resolve(`headless.case-distill.summary.section.${key}`)
      : SUMMARY_SECTIONS[key as keyof typeof SUMMARY_SECTIONS].text
  return [
    resolve ? resolve('headless.case-distill.summary.contract') : SUMMARY_CONTRACT,
    `${sec('case')}\nslug: ${m.slug}\ntitle: ${m.title}\njira: ${m.jiraKey ?? '—'}\nstatus: ${m.status ?? 'closed'}\nresolution: ${m.resolution ?? '—'}\ntags: ${m.tags.join(', ') || '—'}`,
    `${sec('dossier')}\n${JSON.stringify(dossier, null, 2)}`,
    sec('output-nudge')
  ].join('\n\n')
}

const isStr = (v: unknown): v is string => typeof v === 'string' && v.trim().length > 0

export function parseSummary(text: string): CaseDistillSummary | null {
  const fences = [...text.matchAll(/```json\s*\n([\s\S]*?)\n```/g)]
  if (fences.length !== 1)
    throw new DistillParseError(`expected exactly 1 json fence, got ${fences.length}`, text)
  let obj: unknown
  try {
    obj = JSON.parse(fences[0][1])
  } catch (e) {
    throw new DistillParseError(`invalid JSON: ${(e as Error).message}`, text)
  }
  if (typeof obj !== 'object' || obj === null || Array.isArray(obj))
    throw new DistillParseError('output is not an object', text)
  const o = obj as Record<string, unknown>
  for (const k of Object.keys(o))
    if (k !== 'summary') throw new DistillParseError(`unknown key "${k}"`, text)
  if (o.summary === undefined || o.summary === null) return null
  const s = o.summary as Record<string, unknown>
  if (
    typeof s !== 'object' ||
    !isStr(s.signature) ||
    !isStr(s.symptoms) ||
    !isStr(s.rootCause) ||
    !isStr(s.fix) ||
    !Array.isArray(s.keywords) ||
    !s.keywords.every(isStr)
  )
    throw new DistillParseError('summary fields invalid', text)
  return s as unknown as CaseDistillSummary
}
