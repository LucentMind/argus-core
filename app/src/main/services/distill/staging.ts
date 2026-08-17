import type { DatabaseSync } from 'node:sqlite'
import type { CaseDistillOutput } from '../../../shared/distill'
import {
  writeProposal,
  listProposals,
  listArchivedProposals,
  removePendingProposal,
  isValidProposalTarget,
  batchProposalChanges
} from '../proposals'
import { renderSummaryMarkdown } from './summaries'
import { getCase } from '../caseService'

export interface StageResult {
  staged: number
  droppedDuplicates: number
  supersededRemoved: number
  /** Proposals the batch produced but never staged, in the order encountered/dropped (basis
   *  drops as encountered while filtering, cap drops afterward in trailing model-output order).
   *  Case-summary staging never contributes here — it is exempt from both gates below. */
  dropped: { type: string; target: string; title: string; reason: 'cap' | 'basis' }[]
}

/** Per-resolution ceiling on how many non-summary proposals a single distill run may stage —
 *  keeps an over-producing run from flooding the review queue. Looked up via `?? 1` at the call
 *  site, so any resolution this table doesn't know about (defensive; every real `CaseResolution`
 *  plus the synthetic 'open' is listed) still gets a conservative cap instead of an unbounded one.
 *  Case-summary staging is exempt entirely (singular by construction — `output.summary` is at
 *  most one item), so it never competes for one of these slots. */
export const RESOLUTION_CAPS: Record<string, number> = {
  solved: 3,
  open: 2,
  'wont-fix': 2,
  forwarded: 1,
  duplicate: 1,
  rejected: 1,
  'not-reproducible': 1
}

/** A proposal whose cited `basis` is shorter than this, after trimming, is dropped before the cap
 *  is even applied — an unsupported claim doesn't compete for one of the case's limited staging
 *  slots (and doesn't count against `RESOLUTION_CAPS` either). */
export const BASIS_MIN_CHARS = 20

const key = (type: string, target: string): string => `${type} ${target}`

/** Single source of truth for "what resolution does this case's distilled output count as" —
 *  used both to size `RESOLUTION_CAPS` and to stamp the case-summary's own `resolution`
 *  frontmatter (previously computed twice, once per call site — a documented two-representations
 *  defect class in this repo). An open case has no resolution, and defaulting it to 'solved'
 *  would file a live investigation in the summaries corpus as a solved one. */
function deriveResolution(c: { resolution: string | null; status: string } | null): string {
  return c?.resolution ?? (c?.status === 'open' ? 'open' : 'solved')
}

interface PriorReject {
  tag?: string
  note?: string
  caseSlug: string
  recency: string
}

/** Cross-case "this exact target was already rejected elsewhere" lookup, built once per staging
 *  call from the full archive. Keyed by `type target`; when more than one OTHER case rejected the
 *  same target, the most recently rejected one wins — by `rejectedAt`, falling back to the
 *  archived row's own creation `date` for pre-Task-8 rows with no `rejectedAt` (same recency rule
 *  Task 8 established). Same-case rejects are excluded on purpose: that ground is already covered
 *  by the sibling `previously_reviewed` mechanism in `stage()` below, and stamping a case's own
 *  reject back onto itself as `prior_reject_case: <itself>` would be misleading noise rather than
 *  a cross-case warning. */
function buildPriorRejectMap(argusHome: string, caseSlug: string): Map<string, PriorReject> {
  const map = new Map<string, PriorReject>()
  for (const p of listArchivedProposals(argusHome)) {
    if (p.status !== 'rejected' || p.caseSlug === caseSlug) continue
    const k = key(p.type, p.target)
    const recency = p.rejectedAt ?? p.date
    const existing = map.get(k)
    if (existing && existing.recency >= recency) continue
    map.set(k, { tag: p.rejectReason, note: p.rejectNote, caseSlug: p.caseSlug, recency })
  }
  return map
}

/** Frontmatter for a cross-case prior-reject match, or `{}` when there is none. Three single-line
 *  keys (frontmatter values must be single-line) — never JSON. `prior_reject_tag`/`_note` are only
 *  included when the matched reject actually recorded them (an old reject with no reason tag
 *  still yields a bare `prior_reject_case`). Stamped, never a reason to drop the proposal. */
function priorRejectFm(
  map: Map<string, PriorReject>,
  type: string,
  target: string
): Record<string, string> {
  const hit = map.get(key(type, target))
  if (!hit) return {}
  return {
    prior_reject_case: hit.caseSlug,
    ...(hit.tag ? { prior_reject_tag: hit.tag } : {}),
    ...(hit.note ? { prior_reject_note: hit.note } : {})
  }
}

/**
 * Bridges parsed distiller output into inert proposal files.
 *
 * Supersede is intentionally narrowed to distiller-produced (job-stamped) pending
 * proposals only — a mid-case contribute-back item authored by the user (no `job:`
 * frontmatter) is never removed by a later distill run, even if it targets the same
 * case. This is a deliberate refinement of the original plan: the plan's supersede
 * step matched on caseSlug alone, which would have let an automated re-run silently
 * discard a human's own pending work.
 */
export function stageDistillOutput(
  db: DatabaseSync,
  argusHome: string,
  caseSlug: string,
  jobId: number,
  output: CaseDistillOutput
): StageResult {
  // Validate every staged-item target up front, before the destructive supersede step
  // below removes anything. writeProposal throws on a target failing NAME_RE, and the
  // distiller's LLM output can plausibly produce an invalid target (spaces, >64 chars).
  // If that throw happened inside the write loop below, it would fire after the case's old
  // job-stamped pending proposals were already deleted, losing staged knowledge with nothing
  // written to replace it. Failing here, before anything is touched, keeps the old staged
  // items intact when the job errors.
  const invalidTargets = (output.proposals ?? [])
    .map((p) => p.target)
    .filter((t) => !isValidProposalTarget(t))
  if (invalidTargets.length > 0) {
    throw new Error(
      `stageDistillOutput: invalid target(s): ${invalidTargets.map((t) => JSON.stringify(t)).join(', ')}`
    )
  }

  // One announcement for the whole batch — each removal/write below would
  // otherwise broadcast (and recount the pending set) individually.
  return batchProposalChanges(() => {
    let supersededRemoved = 0
    for (const p of listProposals(argusHome)) {
      if (p.caseSlug === caseSlug && p.jobId !== undefined) {
        removePendingProposal(argusHome, p.file)
        supersededRemoved++
      }
    }

    const pendingKeys = new Set(
      listProposals(argusHome)
        .filter((p) => p.caseSlug === caseSlug)
        .map((p) => key(p.type, p.target))
    )
    const reviewedKeys = new Set(
      listArchivedProposals(argusHome)
        .filter((p) => p.caseSlug === caseSlug)
        .map((p) => key(p.type, p.target))
    )

    let staged = 0
    let droppedDuplicates = 0
    const job = String(jobId)

    const stage = (
      type: string,
      target: string,
      title: string,
      content: string,
      extra: Record<string, string>
    ): void => {
      const k = key(type, target)
      if (pendingKeys.has(k)) {
        droppedDuplicates++
        return
      }
      const prevReviewedFm: Record<string, string> = reviewedKeys.has(k)
        ? { previously_reviewed: 'true' }
        : {}
      writeProposal(
        argusHome,
        caseSlug,
        { type, target, title, content },
        { job, ...extra, ...prevReviewedFm }
      )
      pendingKeys.add(k)
      staged++
    }

    // Computed once, unconditionally: the cap needs `resolution` even when there is no summary
    // to stamp it onto, and the summary block below reuses the same `c`/`resolution` rather than
    // re-querying (see deriveResolution's doc comment).
    const c = getCase(db, caseSlug)
    const resolution = deriveResolution(c)
    const cap = RESOLUTION_CAPS[resolution] ?? 1
    const dropped: StageResult['dropped'] = []
    const withBasis = (output.proposals ?? []).filter((p) => {
      if ((p.basis ?? '').trim().length >= BASIS_MIN_CHARS) return true
      dropped.push({ type: p.type, target: p.target, title: p.title, reason: 'basis' })
      return false
    })
    const kept = withBasis.slice(0, cap)
    for (const p of withBasis.slice(cap)) {
      dropped.push({ type: p.type, target: p.target, title: p.title, reason: 'cap' })
    }

    const priorRejectMap = buildPriorRejectMap(argusHome, caseSlug)
    for (const p of kept) {
      stage(p.type, p.target, p.title, p.content, {
        basis: p
          .basis!.replace(/[\r\n]+/g, ' ')
          .trim()
          .slice(0, 300),
        ...priorRejectFm(priorRejectMap, p.type, p.target)
      })
    }

    if (output.summary) {
      // upsertCaseSummary is keyed by case_slug (ON CONFLICT DO UPDATE), so a post-close accept
      // overwrites this row. Case-summary staging is exempt from both the cap above and the
      // basis gate — it is singular by construction, never a candidate for `dropped`.
      stage(
        'case-summary',
        caseSlug,
        `Case summary: ${output.summary.signature}`,
        renderSummaryMarkdown(output.summary, {
          slug: caseSlug,
          title: c?.title ?? caseSlug,
          jiraKey: c?.jiraKey ?? null,
          resolution
        }),
        { summary_json: JSON.stringify(output.summary), resolution }
      )
    }

    return { staged, droppedDuplicates, supersededRemoved, dropped }
  })
}
