import type { CaseDistillInput } from './distill'
import type { PipelineStages } from './distillV3'

export interface DistillEvalItem {
  type: string
  target: string
  title: string
  outcome: 'accepted' | 'rejected'
  rejectReason?: string
  rejectNote?: string
  /** The evidence/reasoning the agent cited for proposing this item (staging's `basis`
   *  frontmatter), when present. */
  basis?: string
  /** The human-edited accept text, when the accepter changed it from the agent's draft
   *  (proposals.ts stamps `edited: true` and appends the accepted text after a delimiter). */
  editedContent?: string
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
    /** v3: per-stage records (prompt hash, raw output, usage, error). Absent on v2 rows. */
    stages?: PipelineStages
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
