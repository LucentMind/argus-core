export type CaseStatus = 'open' | 'analyzing' | 'rca-drafted' | 'closed'

export type ArtifactType =
  | 'applog'
  | 'binlog'
  | 'archive-rec'
  | 'list-json'
  | 'tagged-json'
  | 'bintrace'
  | 'archive'
  | 'screenshot'
  | 'text'
  | 'unknown'

export type EvidenceOrigin = 'upload' | 'jira' | 's3' | 'agent'

export interface NewCaseInput {
  slug: string
  title: string
  jiraKey?: string
}

export interface CaseRecord {
  id: number
  slug: string
  title: string
  jiraKey: string | null
  status: CaseStatus
  tags: string[]
  createdAt: string // ISO 8601
  updatedAt: string
}

export interface EvidenceRecord {
  id: number
  caseId: number
  relPath: string // relative to the case dir, e.g. "evidence/applog.txt"
  sha256: string
  artifactType: ArtifactType
  size: number
  origin: EvidenceOrigin
  meta: Record<string, unknown>
  createdAt: string
}

export interface SearchFilters {
  caseSlug?: string
  artifactType?: ArtifactType
}

export interface SearchHit {
  evidenceId: number
  caseSlug: string
  relPath: string
  artifactType: ArtifactType
  snippet: string // matched terms wrapped in « »
  startLine: number
  endLine: number
  matchLine: number // exact line of the first term match; falls back to startLine
}

export interface WorkspaceInfo {
  path: string
  remote: string | null
  branch: string | null // branch recorded at link time
  currentRef: string // current checked-out ref of the tree the case sees
  dirty: boolean
  worktreePath: string | null // non-null once workspace_checkout materialized one
}

export interface ApprovalDecision {
  requestId: string
  kind: 'allow' | 'allow-session' | 'deny'
  comment?: string
}

export interface AuthStatus {
  ok: boolean
  detail: string // "logged in as x@y (subscription)" | "not logged in" | error text
  /** From the SDK init message's `account` object. Absent on older CLIs or when not logged in. */
  email?: string
  /** Human-readable subscription/auth-method label, e.g. "Claude Max Subscription" or "API key". */
  subscription?: string
  /** CLI version reported by the init message, e.g. "2.1.204". */
  version?: string
}

export interface SkillMeta {
  name: string
  description: string
}

export interface PreflightCheck {
  name: string
  ok: boolean
  detail: string
}
export interface PreflightReport {
  ok: boolean
  checks: PreflightCheck[]
}

export interface CaseCost {
  inputTokens: number
  outputTokens: number
  costUsd: number
}
