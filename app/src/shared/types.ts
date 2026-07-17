export type CaseStatus = 'open' | 'analyzing' | 'rca-drafted' | 'closed'

export type CaseResolution =
  'solved' | 'rejected' | 'forwarded' | 'wont-fix' | 'duplicate' | 'not-reproducible'

export const CASE_RESOLUTIONS: readonly CaseResolution[] = [
  'solved',
  'rejected',
  'forwarded',
  'wont-fix',
  'duplicate',
  'not-reproducible'
]

/**
 * Artifact type of an evidence file. Open-ended: packs define domain types via
 * manifest detectors[]; Core's generic detection yields 'archive' | 'screenshot'
 * | 'text' | 'unknown'.
 */
export type ArtifactType = string

export interface ArtifactTypeMeta {
  type: string
  displayName: string
  analyzeSkill: string | null
  isText: boolean
}

export type EvidenceOrigin = 'upload' | 'jira' | 's3' | 'agent' | 'panel'

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
  /** Last successful Jira sync (create-from-ticket or refresh); null when never synced. */
  jiraSyncedAt: string | null
  status: CaseStatus
  /** Why the case was closed; non-null iff status === 'closed'. */
  resolution: CaseResolution | null
  tags: string[]
  createdAt: string // ISO 8601
  updatedAt: string
}

export interface SessionSummary {
  id: number
  title: string
  turnCount: number
  updatedAt: string
}

export interface EvidenceRecord {
  id: number
  caseId: number
  relPath: string // relative to the case dir, e.g. "evidence/app.log"
  sha256: string
  artifactType: ArtifactType
  size: number
  origin: EvidenceOrigin
  meta: Record<string, unknown>
  createdAt: string
}

export interface FileNode {
  name: string
  relPath: string // forward-slash relative path from the case dir
  kind: 'dir' | 'file'
  size: number // 0 for dirs
  children?: FileNode[] // present iff kind === 'dir'
  evidence?: { id: number; artifactType: ArtifactType; derived: boolean }
}

export type FileReadResult = { content: string; tooLarge?: never } | { tooLarge: true }

export type SearchSource = 'evidence' | 'chat' | 'summaries'

export interface SearchFilters {
  caseSlug?: string
  artifactType?: ArtifactType
  /** Which FTS backends to hit; omitted = evidence only (back-compat for existing callers). */
  sources?: SearchSource[]
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

export interface EvidenceHit extends SearchHit {
  kind: 'evidence'
}

export interface ChatHit {
  kind: 'chat'
  caseSlug: string
  sessionId: number
  sessionTitle: string
  turnId: number | null
  role: string
  snippet: string // matched terms wrapped in « »
}

export interface SummaryHit {
  kind: 'summary'
  caseSlug: string
  signature: string
  resolution: string
  snippet: string // matched terms wrapped in « »
}

export type UnifiedHit = EvidenceHit | ChatHit | SummaryHit

export interface ChatSearchHit {
  sessionId: number
  turnId: number | null
  role: string
  snippet: string
}

export interface ChatSearchResult {
  hits: ChatSearchHit[]
  error?: string
}

/**
 * What a chat-search jump needs to land on the matched message. FTS rows have
 * no per-message id — a hit is (turn, role, snippet) — so the transcript view
 * resolves the exact message in-turn via role + snippet text.
 */
export interface ChatJumpTarget {
  turnId: number | null
  role?: string
  snippet?: string
}

export interface WorkspaceInfo {
  path: string
  remote: string | null
  branch: string | null // branch recorded at link time
  currentRef: string // current checked-out ref of the tree the case sees
  dirty: boolean
  worktreePath: string | null // non-null once workspace_checkout materialized one
}

export interface GraphStatusRow {
  scope: string | null
  scopeKey: string
  status: 'ok' | 'failed' | 'building' | 'none'
  commit: string | null
  behind: number | null
  builtAt: string | null
  nodeCount: number | null
  error?: string
}

/** Live progress line streamed from a running `graphify extract`, keyed by repo + scope. */
export interface GraphProgress {
  repoPath: string
  scope: string | null
  message: string
  /** 0-100 when graphify reports a percentage (e.g. AST extraction), else null. */
  percent: number | null
}

export interface ApprovalDecision {
  requestId: string
  kind: 'allow' | 'allow-session' | 'deny'
  comment?: string
  /** Edited tool input (connector-tool MEDIUM preview, spec §3.4); honored on allow/allow-session for the current call, connector MCP tools only. */
  updatedInput?: Record<string, unknown>
}

export interface AuthStatus {
  ok: boolean
  detail: string // "logged in as x@y (subscription)" | "not logged in" | error text
  /**
   * True only once a real turn has authenticated against the API. The probe runs with
   * maxTurns:0 and never contacts the API, so `ok: true, verified: false` means
   * "CLI ready, account on file, sign-in not yet proven". Do not render this as
   * "logged in" (spec §4).
   */
  verified: boolean
  /** From the SDK query handle's `initializationResult().account`. Absent when not logged in. */
  email?: string
  /** Human-readable subscription/auth-method label, e.g. "Claude Max Subscription" or "API key". */
  subscription?: string
  /** CLI version from the init message's `claude_code_version` field, e.g. "2.1.205". */
  version?: string
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
