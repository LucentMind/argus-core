import type { FindingRole } from './observability'

export interface Citation {
  path: string
  line?: number
  evidence?: string
}

export interface RcaDraft {
  rootCause: { findingId: number | null; statement: string; evidence: Citation[] }
  contributing: { findingId: number | null; statement: string; evidence: Citation[] }[]
  symptoms: { findingId: number | null; statement: string }[]
  ruledOut: { findingId: number | null; statement: string; why: string }[]
  duplicates: { findingId: number; ofFindingId: number }[]
  impact: string
  timeline: { at: string; what: string }[]
  remediation: { immediate: string; followUps: string[] }
  execSummary: { whatBroke: string; impact: string; why: string; nextSteps: string }
  techNarrative: { heading: string; body: string; citations: Citation[] }[]
}

export type RcaJobState = 'queued' | 'running' | 'done' | 'failed'

export interface PostTargetResult {
  ok: boolean
  url?: string
  id?: string
  error?: string
  at: string
}
export interface PostResults {
  comment?: PostTargetResult
  attachment?: PostTargetResult
  confluencePage?: PostTargetResult
}

export interface RcaJobRow {
  id: number
  caseSlug: string
  state: RcaJobState
  error: string | null
  confirmedAt: string | null
  postResults: PostResults | null
  createdAt: string
  finishedAt: string | null
}

/** status payload: job row + parsed draft when state='done' (parsed from raw_output). */
export interface RcaStatusPayload {
  caseSlug: string
  job: RcaJobRow | null
  draft: RcaDraft | null
}

export interface RoleAssignment {
  findingId: number
  role: FindingRole | null
}
