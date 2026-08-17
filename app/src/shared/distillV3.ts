/** Distillation v3 — staged pipeline shapes shared by main, the eval harness and the export. */

export type DossierCite =
  | { finding: number }
  | { session: number; turn: number }
  | { evidence: string }

export interface DossierCited {
  cites: DossierCite[]
}

export interface Dossier {
  scope: {
    status: 'open' | 'closed'
    resolution: string | null
    settled: boolean
    note: string
  }
  root_cause: ({ text: string } & DossierCited) | null
  confirmed_fix: ({ text: string; applied: boolean } & DossierCited) | null
  rejected_hypotheses: ({ text: string; how_ruled_out: string } & DossierCited)[]
  diagnostic_path: ({ step: string; observation: string; discriminated: string } & DossierCited)[]
  durable_facts: ({ fact: string; quote: string; scope: string | null } & DossierCited)[]
  user_corrections: ({ text: string } & DossierCited)[]
}

/** A reference into the dossier: `root_cause`, `confirmed_fix`, or `<array>[<index>]`. */
export type DossierPath = string

export type CandidateKind = 'procedure' | 'fact'
export type ProposalOutType = 'skill-new' | 'skill-edit' | 'reference-edit'

export interface KnowledgeCandidate {
  kind: CandidateKind
  type: ProposalOutType
  target: string
  title: string
  outline: string
  evidence: DossierPath[]
  related: string[]
  generalization: string
  routing_rationale: string
  confidence: number
}

export type VetoReason =
  | 'malformed'
  | 'unknown-target'
  | 'target-exists'
  | 'confluence-tier'
  | 'bad-name'
  | 'duplicate'
  | 'kind-type-mismatch'
  | 'cap'

export type PatchOpKind = 'append-section' | 'replace-section' | 'insert-after' | 'append-file'

export interface PatchOp {
  op: PatchOpKind
  /** Required for every op except `append-file`. Exact heading line, e.g. "## Diagnostic steps". */
  heading?: string
  content: string
}

export interface MaterializeOutput {
  /** skill-new only: the complete SKILL.md */
  file?: string
  /** edits only */
  frontmatter?: { description?: string } | null
  ops?: PatchOp[]
  supersedes?: { asset: string; note: string }[]
  whole_file?: string | null
  basis: string
}

export type ValidatorReason =
  | 'frontmatter'
  | 'bad-name'
  | 'case-identifiers'
  | 'steps-in-reference'
  | 'broad-edit'
  | 'basis'
  | 'patch-error'
  | 'materialize-error'

export interface StageUsage {
  inputTokens?: number
  outputTokens?: number
  costUsd?: number
  durationMs?: number
}

export interface StageRecord {
  promptHash: string
  promptChars: number
  rawOutput: string
  usage?: StageUsage
  error?: string
}

/** Per-candidate drop recorded before staging (veto or validator). Same shape staging's
 *  `dropped` uses, with the reason set widened. */
export interface PreStageDrop {
  type: string
  target: string
  title: string
  reason: VetoReason | ValidatorReason
}

export interface PipelineStages {
  dossier?: StageRecord
  summary?: StageRecord
  candidates?: StageRecord
  materialize?: (StageRecord & { type: string; target: string })[]
  /** Uncited dossier items the parser dropped, by array key. */
  dossierUncitedDropped?: Record<string, number>
}
