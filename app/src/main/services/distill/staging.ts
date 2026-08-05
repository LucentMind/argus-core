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
}

const key = (type: string, target: string): string => `${type} ${target}`

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

    for (const p of output.proposals ?? []) {
      stage(p.type, p.target, p.title, p.content, {})
    }

    if (output.summary) {
      const c = getCase(db, caseSlug)
      // An open case has no resolution, and defaulting it to 'solved' would file a live
      // investigation in the summaries corpus as a solved one. upsertCaseSummary is keyed by
      // case_slug (ON CONFLICT DO UPDATE), so a post-close accept overwrites this row.
      const resolution = c?.resolution ?? (c?.status === 'open' ? 'open' : 'solved')
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

    return { staged, droppedDuplicates, supersededRemoved }
  })
}
