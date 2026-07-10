// Jira/Atlassian REST types shared by main and renderer (Wave 2 Part 3).
// The REST client is UI-native only — the agent's Jira access is Rovo MCP.

export interface JiraAttachmentInfo {
  id: string
  filename: string
  size: number
  mimeType: string
  createdAt: string
}

export interface JiraIssuePreview {
  key: string
  summary: string
  status: string
  labels: string[]
  reporter: string | null
  created: string
  updated: string
  attachments: JiraAttachmentInfo[]
}

export interface JiraAttachmentProgress {
  caseSlug: string
  attachmentId: string
  filename: string
  status: 'downloading' | 'done' | 'error'
  evidenceId?: number
  error?: string
}

export interface JiraRefreshSummary {
  key: string
  statusChange: { from: string; to: string } | null
  newAttachments: JiraAttachmentInfo[]
  /** Noted only — evidence is append-only, nothing is removed locally. */
  deletedOnJira: Array<{ attachmentId: string; filename: string }>
  /** When this refresh ran (also persisted as CaseRecord.jiraSyncedAt). */
  syncedAt: string
}

export const ATLASSIAN_ERROR_CODES = [
  'not-configured', // no rovo-preset connector in the registry
  'no-site-url', // connector has no siteUrl config
  'no-token', // apiToken secret missing/unresolvable
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
