import { z } from '../../../shared/zodConfig'
import type { RcaDraft } from '../../../shared/rca'
import type { RcaTemplate } from '../../../shared/rcaTemplate'

export class RcaParseError extends Error {
  constructor(
    message: string,
    public raw: string
  ) {
    super(message)
  }
}

const citation = z.object({
  path: z.string().min(1),
  line: z.number().int().optional(),
  evidence: z.string().optional()
})
const claim = z.object({
  findingId: z.number().int().nullable(),
  statement: z.string().min(1),
  evidence: z.array(citation).default([])
})
const draftSchema = z.object({
  rootCause: claim,
  contributing: z.array(claim).default([]),
  symptoms: z
    .array(z.object({ findingId: z.number().int().nullable(), statement: z.string().min(1) }))
    .default([]),
  ruledOut: z
    .array(
      z.object({
        findingId: z.number().int().nullable(),
        statement: z.string().min(1),
        why: z.string().min(1)
      })
    )
    .default([]),
  duplicates: z
    .array(z.object({ findingId: z.number().int(), ofFindingId: z.number().int() }))
    .default([]),
  impact: z.string().default(''),
  timeline: z.array(z.object({ at: z.string(), what: z.string() })).default([]),
  remediation: z.object({
    immediate: z.string().default(''),
    followUps: z.array(z.string()).default([])
  }),
  execSummary: z.object({
    whatBroke: z.string(),
    impact: z.string(),
    why: z.string(),
    nextSteps: z.string()
  }),
  techNarrative: z
    .array(
      z.object({
        heading: z.string().min(1),
        body: z.string(),
        citations: z.array(citation).default([])
      })
    )
    .default([]),
  /** Keyed by `RcaSection.id`; the template's expected ids are checked separately (see
   *  `missingSections`) because an id is only required when a template asked for it. A factory
   *  default, matching the repo's other `z.record` schemas: a literal `{}` default is handed
   *  out by reference on every parse, so one draft's mutation would leak into the next. */
  sections: z
    .record(z.string(), z.object({ body: z.string(), citations: z.array(citation).default([]) }))
    .default(() => ({}))
})

/** The section ids the model must return for a template: every ENABLED narrative section,
 *  exec first then tech, in template order. Claims sections are excluded — they render fixed
 *  draft structure the model already produces under its own keys. */
export function expectedSectionIds(template: RcaTemplate): string[] {
  return [...template.exec, ...template.tech]
    .filter((s) => s.enabled && s.kind === 'narrative')
    .map((s) => s.id)
}

/** Names every expected id the draft is missing, or null when all are present. */
function missingSections(draft: RcaDraft, expectedIds: string[]): string | null {
  const missing = expectedIds.filter((id) => !(id in draft.sections))
  return missing.length ? `missing section(s): ${missing.join(', ')}` : null
}

export function parseRcaOutput(text: string, expectedIds?: string[]): RcaDraft {
  const fences = [...text.matchAll(/```json\s*\n([\s\S]*?)\n```/g)]
  if (fences.length !== 1)
    throw new RcaParseError(`expected exactly 1 json fence, got ${fences.length}`, text)
  let obj: unknown
  try {
    obj = JSON.parse(fences[0][1])
  } catch (e) {
    throw new RcaParseError(`invalid JSON: ${(e as Error).message}`, text)
  }
  const res = draftSchema.safeParse(obj)
  if (!res.success) throw new RcaParseError(res.error.issues[0]?.message ?? 'invalid draft', text)
  const draft = res.data as RcaDraft
  if (expectedIds) {
    const missing = missingSections(draft, expectedIds)
    // Same RcaParseError path as a schema failure: the job lands in `failed` with raw_output
    // preserved, so the panel shows the model's actual text rather than swallowing it.
    if (missing) throw new RcaParseError(missing, text)
  }
  return draft
}

/**
 * Re-validates an already-parsed `RcaDraft` against the same schema `parseRcaOutput` uses —
 * for the IPC boundary (`rca:confirm`, `rca:render-preview`), where the payload is a
 * structured object from the renderer, not raw model text with a json fence to extract.
 * Called BEFORE either handler touches any state (role writes, artifact files) so a
 * malformed/stale `edited` draft is rejected up front rather than partially applied.
 */
export function validateRcaDraft(v: unknown, expectedIds?: string[]): RcaDraft {
  const res = draftSchema.safeParse(v)
  if (!res.success) throw new Error(res.error.issues[0]?.message ?? 'invalid RCA draft')
  const draft = res.data as RcaDraft
  if (expectedIds) {
    const missing = missingSections(draft, expectedIds)
    if (missing) throw new Error(missing)
  }
  return draft
}
