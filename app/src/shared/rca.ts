import type { FindingRole } from './observability'
import type { RcaTemplate } from './rcaTemplate'
import type { TicketProviderId } from './ticketRef'

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
  /** Model-authored body per template narrative section, keyed by `RcaSection.id`. Empty on
   *  drafts generated before the template drove the prompt — the renderer falls back to the
   *  legacy field that section used to render from, so old confirmed reports still render. */
  sections: Record<string, { body: string; citations: Citation[] }>
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
  /** The template the job was generated under — its snapshot, or the default for a row that
   *  predates the column. Rendering and the panel's section list both read this, never live
   *  settings, so a template edit cannot retroactively blank a section of a pending draft. */
  template: RcaTemplate
  /** Section ids dropped when this job was confirmed, per report; `{}` for an unconfirmed job,
   *  a row that predates the column, or an unreadable cell. Persisted so a re-render after a
   *  reload reproduces the confirmed bytes rather than silently restoring dropped sections. */
  dropped: RcaDroppedSections
}

export interface RoleAssignment {
  findingId: number
  role: FindingRole | null
}

/** Per-report set of section ids to omit from a preview render. Keyed by report (`exec`/`tech`)
 *  rather than one shared list of ids: the DEFAULT ids are globally unique (`exec-impact` vs
 *  `tech-impact`), but a user template may still reuse an id across the two lists, and a single
 *  shared set would then strip a section from one report because the user dropped its same-named
 *  counterpart in the other. */
export interface RcaDroppedSections {
  exec?: string[]
  tech?: string[]
}

export interface CaseRcaInput {
  caseMeta: {
    slug: string
    title: string
    jiraKey: string | null
    resolution: string | null
    tags: string[]
    createdAt: string
    /** `CaseRecord.ticketProvider`, for naming the right tracker in the rendered report and
     *  the model-facing prompt instead of always saying "Jira". Optional (defaulting to
     *  `'jira'` at every read site) so the many existing test fixtures that build this shape
     *  by hand don't all need updating — every real caller passes it (see `assembleRcaInput`,
     *  the `rca:render-preview` handler, and `RcaJobs.confirm`). */
    ticketProvider?: TicketProviderId
  }
  /** Investigation-mode findings only; id included so the draft can link claims. */
  findings: {
    id: number
    summary: string
    body: string
    reviewState: string
    /** Why it was rejected. Optional: absent on every snapshot taken before retraction
     *  existed, and a retry replays its original snapshot verbatim. */
    reviewReason?: string | null
    /** Who rejected it. 'agent' means the agent withdrew its own finding. */
    reviewActor?: 'agent' | 'human' | null
    role: string | null
  }[]
  evidence: { relPath: string; artifactType: string; size: number }[]
  jiraTicketMarkdown: string | null
  jiraCommentsMarkdown: string | null
  /** Per investigation session: title + tail of its chat text (user/assistant). */
  transcripts: { title: string; text: string }[]
  priorDraft: RcaDraft | null
}
