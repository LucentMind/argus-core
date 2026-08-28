import type { CaseResolution, CaseStatus } from './types'
import type { ReviewState } from './observability'
import type { RcaDraft } from './rca'
import type { PipelineStages, PreStageDrop } from './distillV3'

export type DistillJobState = 'queued' | 'running' | 'done' | 'failed' | 'cancelled'

export interface WorldMessage {
  role: string
  content: string
  truncated?: true
}

export interface WorldSession {
  id: number
  title: string
  messages: WorldMessage[]
  /** honest-elision counters — served tool results repeat them */
  droppedMessages?: number
}

export interface DistillWorld {
  sessions: WorldSession[]
  droppedSessions?: number
}

export interface DistillJobRow {
  id: number
  caseSlug: string
  state: DistillJobState
  error: string | null
  /** Number of items staged; 0 = "nothing to distill". Null until done. */
  itemCount: number | null
  createdAt: string
  finishedAt: string | null
  /** v2 agentic-run cost/usage columns — null until a job records them (pre-v2 rows, or a
   *  job still queued/running). Populated on BOTH a done job and a failed capHit job (Task 12):
   *  a run that burned its budget still spent real tokens worth showing the operator. */
  costUsd: number | null
  turnCount: number | null
  toolCallCount: number | null
  promptChars: number | null
  /** True when this run deliberately skipped staging (a comparison run — see the dry-run
   *  design). `itemCount` is NULL on such a row: staging never ran, as distinct from ran and
   *  staged nothing. */
  dryRun: boolean
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
  findings: {
    /** DB id — v3 dossier cites findings by id. Absent on pre-v3 snapshots. */
    id?: number
    summary: string
    reviewState: ReviewState
    /** Why it was rejected. Optional: absent on every snapshot taken before retraction
     *  existed, and a retry replays its original snapshot verbatim. */
    reviewReason?: string | null
    /** Who rejected it. 'agent' means the agent withdrew its own finding. */
    reviewActor?: 'agent' | 'human' | null
    role: string | null
    body: string
  }[]
  evidence: { relPath: string; artifactType: string; size: number }[]
  sessionTitles: string[]
  /** `content` is the full current SKILL.md (frontmatter + body) — a skill-edit must
   *  return the whole file with its change merged in, so the distiller needs it verbatim. */
  skillsIndex: { name: string; description: string; content: string; note?: string }[]
  /** `content` is the full current reference file (frontmatter + body), for the same reason.
   *  `tier` is the reference's trust_tier ('confluence' = auto-synced/overwritten, so never an
   *  edit target; 'team-knowledge'/null = hand-owned). null when the file has no frontmatter. */
  referencesIndex: {
    name: string
    summary: string
    content: string
    tier: string | null
    note?: string
  }[]
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
  /** Frozen world snapshot for the agentic distiller's tools (v2). Built once at enqueue,
   *  never re-read from the live DB. Absent for pre-v2 snapshots. */
  world?: DistillWorld
  /** Verbatim user turns, grouped by session — the agentic distiller's raw-quote source. */
  userMessages?: { sessionTitle: string; messages: string[] }[]
  /** Digest of prior reject reasons for this case's proposals, if any were rejected. */
  rejectDigest?: string
  /** Free-text operator guidance supplied at enqueue time, if any. */
  operatorGuidance?: string
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
    type: 'skill-new' | 'skill-edit' | 'reference-edit'
    target: string
    title: string
    content: string
    basis?: string
    /** v3: JSON-encoded `DossierCite[]` resolved from the candidate's evidence paths. */
    evidence?: string
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

/** Shape of `readRejectDigest`'s result (`distill/rejectDigest.ts`), shared so the renderer's
 *  read-only digest viewer doesn't need its own parallel type. */
export interface RejectDigest {
  builtAt: string
  rejectCount: number
  text: string
}

/** Everything the run detail panel needs about one distill job. Parsed in main — these columns
 *  are hand-serialized JSON with an open `reason` set, so one defensive parser beats one per
 *  consumer. A column that fails to parse yields null/[] rather than throwing: the panel is the
 *  tool for diagnosing a broken run, so a corrupt column must not make it unopenable. */
export interface DistillRunDetail {
  job: DistillJobRow
  /** Parsed `stages_json`. Null on a v2/v1 run (which recorded no stages) and on a corrupt column. */
  stages: PipelineStages | null
  /** Parsed `dropped_json`. Empty when the column is NULL or corrupt. */
  dropped: PreStageDrop[]
  /** Parsed `trajectory_json`, already truncated at write time by TRAJECTORY_JSON_CAP.
   *  Entry shape is `TrajectoryEntry` (main-only type); the panel renders entries as JSON. */
  trajectory: unknown[] | null
  rawOutput: string | null
  /** Length of `input_snapshot`, not its content — the snapshot embeds every session transcript
   *  and is far too large to ship to the renderer. Enough to answer "did this run get any input". */
  inputSnapshotChars: number
}
