import type { CaseDistillInput } from './distill'
import type { PipelineStages, PreStageDrop } from './distillV3'

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
    /** Everything the run produced but never staged, in drop order: v3's pre-stage drops (veto +
     *  validators) ahead of staging's own cap/basis drops — the job's `dropped_json` column
     *  verbatim. Absent on a failed row (staging never ran) and on rows written before the column
     *  existed. `reason` is an open set: a v2 row carries only `cap`/`basis`, a v3 row every
     *  VetoReason/ValidatorReason too. */
    dropped?: PreStageDrop[]
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
