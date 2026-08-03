import { z } from '../../../shared/zodConfig'
import type { RcaDraft } from '../../../shared/rca'

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
    .default([])
})

export function parseRcaOutput(text: string): RcaDraft {
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
  return res.data as RcaDraft
}

/**
 * Re-validates an already-parsed `RcaDraft` against the same schema `parseRcaOutput` uses —
 * for the IPC boundary (`rca:confirm`, `rca:render-preview`), where the payload is a
 * structured object from the renderer, not raw model text with a json fence to extract.
 * Called BEFORE either handler touches any state (role writes, artifact files) so a
 * malformed/stale `edited` draft is rejected up front rather than partially applied.
 */
export function validateRcaDraft(v: unknown): RcaDraft {
  const res = draftSchema.safeParse(v)
  if (!res.success) throw new Error(res.error.issues[0]?.message ?? 'invalid RCA draft')
  return res.data as RcaDraft
}
