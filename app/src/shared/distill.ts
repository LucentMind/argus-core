import type { CaseResolution, CaseStatus } from './types'
import type { ReviewState } from './observability'
import type { RcaDraft } from './rca'

export type DistillJobState = 'queued' | 'running' | 'done' | 'failed' | 'cancelled'

export interface DistillJobRow {
  id: number
  caseSlug: string
  state: DistillJobState
  error: string | null
  /** Number of items staged; 0 = "nothing to distill". Null until done. */
  itemCount: number | null
  createdAt: string
  finishedAt: string | null
}

export interface CaseDistillInput {
  caseMeta: {
    slug: string
    title: string
    jiraKey: string | null
    /** Distillation can be started on a live case, so the distiller must be told which it is —
     *  `resolution` alone cannot distinguish "open" from "closed with no resolution recorded". */
    status: CaseStatus
    resolution: CaseResolution | null
    tags: string[]
    createdAt: string
    closedAt: string
  }
  findings: { summary: string; reviewState: ReviewState; role: string | null; body: string }[]
  evidence: { relPath: string; artifactType: string; size: number }[]
  sessionTitles: string[]
  /** `content` is the full current SKILL.md (frontmatter + body) — a skill-edit must
   *  return the whole file with its change merged in, so the distiller needs it verbatim. */
  skillsIndex: { name: string; description: string; content: string }[]
  /** `content` is the full current reference file (frontmatter + body), for the same reason.
   *  `tier` is the reference's trust_tier ('confluence' = auto-synced/overwritten, so never an
   *  edit target; 'team-knowledge'/null = hand-owned). null when the file has no frontmatter. */
  referencesIndex: { name: string; summary: string; content: string; tier: string | null }[]
  alreadyCaptured: {
    proposals: {
      type: string
      target: string
      title: string
      state: 'pending' | 'accepted' | 'rejected'
    }[]
  }
  /** `artifacts/rca-structure.json` — the confirmed, human-reviewed RCA structure for this case,
   *  if a report was ever confirmed. null when no such file exists (most cases). */
  rcaStructure: RcaDraft | null
}

export interface CaseDistillSummary {
  signature: string
  symptoms: string
  rootCause: string
  fix: string
  keywords: string[]
}

export interface CaseDistillOutput {
  summary?: CaseDistillSummary
  proposals?: {
    type: 'skill-new' | 'skill-edit' | 'reference-edit' | 'recipe'
    target: string
    title: string
    content: string
  }[]
}

export interface CaseSummaryRecord {
  caseSlug: string
  signature: string
  symptoms: string
  rootCause: string
  fix: string
  keywords: string[]
  resolution: string
  acceptedAt: string
}

export interface SummarySearchHit {
  caseSlug: string
  signature: string
  resolution: string
  snippet: string
}

export interface DistillStatusPayload {
  caseSlug: string
  job: DistillJobRow | null
}
