import type { DatabaseSync } from 'node:sqlite'
import type { CaseDistillOutput } from '../../../shared/distill'
import {
  writeProposal,
  listProposals,
  listArchivedProposals,
  removePendingProposal
} from '../proposals'
import { renderSummaryMarkdown } from './summaries'
import { getCase } from '../caseService'

export interface StageResult {
  staged: number
  droppedDuplicates: number
  supersededRemoved: number
}

const key = (type: string, target: string): string => `${type} ${target}`
const firstLine = (s: string): string => (s.split('\n').find((l) => l.trim()) ?? '').slice(0, 80)

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
    staged++
  }

  for (const m of output.memoryAppends ?? []) {
    stage(
      'memory-append',
      m.topic,
      m.indexEntry ?? firstLine(m.content),
      m.content,
      m.indexEntry ? { index_entry: m.indexEntry } : {}
    )
  }

  for (const p of output.proposals ?? []) {
    stage(p.type, p.target, p.title, p.content, {})
  }

  if (output.summary) {
    const c = getCase(db, caseSlug)
    const resolution = c?.resolution ?? 'solved'
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
}
