import type { CaseDistillInput } from './distill'

export interface DistillEvalItem {
  type: string
  target: string
  title: string
  outcome: 'accepted' | 'rejected'
  rejectReason?: string
  rejectNote?: string
}

/** One NDJSON line of the exported corpus. */
export interface DistillEvalBundleLine {
  job: {
    id: number
    caseSlug: string
    promptHash: string | null
    createdAt: string
    state: 'done' | 'failed'
    inputSnapshot: CaseDistillInput
    rawOutput: string
    error: string | null
  }
  items: DistillEvalItem[]
  exportedAt: string
  argusVersion: string
}

export interface DistillEvalExportResult {
  path: string
  exported: number
  skipped: { jobId: number; caseSlug: string; reason: string }[]
}
