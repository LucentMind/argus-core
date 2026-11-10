import {
  isFindingRole,
  type FindingRole,
  type FindingRow,
  type FindingStatus
} from './observability'

/** What `updateFinding` can change. Only the keys present are written; `role: null` and
 *  `causedBy: null` clear. `appendMarkdown` adds a dated `### Update` section to the body. */
export interface FindingPatch {
  status?: FindingStatus
  role?: FindingRole | null
  causedBy?: number | null
  appendMarkdown?: string
  /** Replaces the body below the heading and meta line (spec 2026-10-26 §9.7: a wrong citation
   *  or number when the claim stands). Exclusive with `appendMarkdown`. Agent only. */
  replaceMarkdown?: string
}

/** Why `updateFinding` wrote nothing. The tool layer and the IPC each own their wording. */
export type UpdateRefusal =
  | 'unknown'
  | 'empty'
  | 'bad-cause'
  | 'self-cause'
  | 'cycle'
  | 'second-root'
  | 'accepted-locked'
  | 'rca-frozen'
  | 'review-mode'
  | 'both-bodies'

export type UpdateResult =
  { ok: true; row: FindingRow } | { ok: false; reason: UpdateRefusal; existingRoot?: number }

/** IPC-boundary validation of a HUMAN chain edit (spec 2026-10-26 §5.4): role and cause only —
 *  status is the agent's claim about evidence and has no human editor. Throws on any other key,
 *  on a bad value, and on an empty patch, before anything is written. */
export function parseHumanFindingPatch(v: unknown): Pick<FindingPatch, 'role' | 'causedBy'> {
  if (!v || typeof v !== 'object') throw new Error(`Invalid finding patch: ${JSON.stringify(v)}`)
  const out: Pick<FindingPatch, 'role' | 'causedBy'> = {}
  for (const [k, val] of Object.entries(v as Record<string, unknown>)) {
    if (k === 'role') {
      if (val !== null && !isFindingRole(val))
        throw new Error(`Invalid role: ${JSON.stringify(val)}`)
      out.role = val
    } else if (k === 'causedBy') {
      if (val !== null && !Number.isInteger(val))
        throw new Error(`Invalid causedBy: ${JSON.stringify(val)}`)
      out.causedBy = val as number | null
    } else {
      throw new Error(`Unknown finding patch key: ${k}`)
    }
  }
  if (Object.keys(out).length === 0) throw new Error('Invalid finding patch: empty')
  return out
}

/** The card's one-line explanation of a refused HUMAN edit (the agent's wording lives in
 *  TOOL_FEEDBACK). The two agent-only refusals never reach a human edit; they still get text. */
export function describeUpdateRefusal(reason: UpdateRefusal, existingRoot?: number): string {
  switch (reason) {
    case 'unknown':
      return 'That finding no longer exists.'
    case 'empty':
      return 'Nothing to change.'
    case 'bad-cause':
      return 'The cause must be another finding of this case.'
    case 'self-cause':
      return 'A finding cannot be caused by itself.'
    case 'cycle':
      return 'That would make a loop in the chain.'
    case 'second-root':
      return `Finding #${existingRoot} is already the confirmed root cause — change its role first.`
    case 'accepted-locked':
      return 'An accepted finding keeps its status and role.'
    case 'rca-frozen':
      return 'That role was set by the confirmed RCA report.'
    case 'review-mode':
      return 'This finding belongs to a review session; status, role and cause apply to investigation findings only.'
    case 'both-bodies':
      return 'Append or replace the body, not both.'
  }
}
