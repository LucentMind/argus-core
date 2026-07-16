import type { CaseResolution } from './types'
import type { ReviewState } from './observability'

export type DistillJobState = 'queued' | 'running' | 'done' | 'failed'

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
    resolution: CaseResolution | null
    tags: string[]
    createdAt: string
    closedAt: string
  }
  findings: { summary: string; reviewState: ReviewState; body: string }[]
  evidence: { relPath: string; artifactType: string; size: number }[]
  sessionTitles: string[]
  memoryIndex: string
  skillsIndex: { name: string; description: string }[]
  referencesIndex: { name: string; summary: string }[]
  alreadyCaptured: {
    proposals: {
      type: string
      target: string
      title: string
      state: 'pending' | 'accepted' | 'rejected'
    }[]
    memoryWrites: { topic: string; indexEntry: string | null }[]
  }
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
  memoryAppends?: { topic: string; content: string; indexEntry?: string }[]
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
