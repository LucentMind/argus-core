// Jira/Atlassian REST types shared by main and renderer (Wave 2 Part 3).
// The REST client is UI-native only — the agent's Jira access is Rovo MCP.

export interface JiraAttachmentInfo {
  id: string
  filename: string
  size: number
  mimeType: string
  createdAt: string
}

/** A Jira clone relation, in whichever direction the fetched issue sits on. */
export interface CloneLink {
  key: string
  summary: string
  /** 'clones' = this issue is the clone; 'is-cloned-by' = this issue is the original. */
  direction: 'clones' | 'is-cloned-by'
}

export interface JiraIssuePreview {
  key: string
  summary: string
  status: string
  /** Priority name (e.g. "High"); null when the field is absent or unset. */
  priority: string | null
  labels: string[]
  reporter: string | null
  created: string
  updated: string
  attachments: JiraAttachmentInfo[]
  /** Clone relations found on the issue. Empty for the overwhelming majority of tickets —
   *  the source-ticket UI renders only when this is non-empty. */
  cloneLinks: CloneLink[]
}

export interface JiraCommentInfo {
  id: string
  author: string | null
  created: string
  updated: string
  bodyMarkdown: string
}

export interface JiraAttachmentProgress {
  caseSlug: string
  attachmentId: string
  filename: string
  status: 'downloading' | 'done' | 'error'
  evidenceId?: number
  error?: string
  /** For a zip archive: number of inner files extracted and ingested. */
  extractedCount?: number
  /** For a zip archive: set when extraction was aborted (cap breach / corrupt). */
  extractError?: string
  /** Set when this attachment's bytes were already present as evidence in this case,
   *  ingested from the named ticket — this download was deduped, not re-copied. A case
   *  bound to a clone and a source ticket very often carries the same file on both, since
   *  a clone's attachments are typically copied from (or shared with) the ticket it was
   *  cloned from. Absent means this is a genuinely new file. */
  dedupedFrom?: string
}

/** A source ticket as the renderer sees it. Refresh bookkeeping (the attachment baseline and
 *  the declined set) is deliberately omitted — nothing in the UI should reason about it. */
export interface JiraSourceLink {
  key: string
  addedAt: string
}

/** Per-source outcome inside a refresh. A source is evidence-only: it is never a post target
 *  and its failure never fails the case's refresh. */
export interface JiraSourceRefresh {
  key: string
  newComments: number
  /** New on the source ticket and pending a user decision — refresh does NOT download. */
  newAttachments: JiraAttachmentInfo[]
  /** Previously declined on this source and still live on the ticket — offered back
   *  unchecked, exactly like the primary's deselectedAttachments. */
  deselectedAttachments: JiraAttachmentInfo[]
  /** Set when this source could not be read; the primary's refresh still ran. */
  error?: string
  /** Set when the source's ticket text loaded but its comments fetch failed — mirrors
   *  JiraRefreshSummary.commentsError. A source with this set must not be treated as a
   *  fully successful source. */
  commentsError?: string
}

export interface JiraRefreshSummary {
  key: string
  statusChange: { from: string; to: string } | null
  /** New on the ticket and pending a user decision — refresh does NOT download. */
  newAttachments: JiraAttachmentInfo[]
  /** Previously deselected ids still live on the ticket (offered unchecked in the dialog). */
  deselectedAttachments: JiraAttachmentInfo[]
  /** Live on the ticket AND already ingested — shown as synced, not re-selectable (spec §4). */
  ingestedAttachments: JiraAttachmentInfo[]
  /** Noted only — evidence is append-only, nothing is removed locally. */
  deletedOnJira: Array<{ attachmentId: string; filename: string }>
  /** Count of comments added since the last sync (0 when the fetch failed). */
  newComments: number
  /** Set when the comments fetch failed; the rest of the refresh still ran. */
  commentsError?: string
  /** One entry per linked source ticket; empty for a case with no sources. */
  sources: JiraSourceRefresh[]
  /** When this refresh ran (also persisted as CaseRecord.jiraSyncedAt). */
  syncedAt: string
}

/** Outcome of a bulk overview sync. */
export interface JiraSyncAllSummary {
  /** Cases attempted (non-closed, with a Jira key). */
  total: number
  synced: number
  /** Cases that SUCCEEDED this run and now carry at least one ACTION-severity
   *  item. Excludes failed cases even though a failure adds a sync-error action
   *  item — that's a failure being reported, not a change. Also excludes
   *  info-severity items (`stale`, `idle`): those describe our sync cadence,
   *  not the ticket, so they must never inflate this count. */
  changed: number
  failed: number
  /** Per-case failures, for the header's result line. */
  failures: Array<{ slug: string; code: AtlassianErrorCode; message: string }>
  finishedAt: string
}

export const ATLASSIAN_ERROR_CODES = [
  'not-configured', // no rovo-preset connector in the registry
  'auth', // HTTP 401/403 — surfaced on the card + Health row
  'not-found', // HTTP 404 — "ticket not found" inline in dialogs
  'network', // fetch rejected / timeout
  'http', // any other non-2xx
  'internal' // unexpected error wrapped by the IPC boundary
] as const
export type AtlassianErrorCode = (typeof ATLASSIAN_ERROR_CODES)[number]

/** jira:* IPC handlers never throw — errors come back typed. */
export type JiraResult<T> =
  { ok: true; value: T } | { ok: false; code: AtlassianErrorCode; message: string }
