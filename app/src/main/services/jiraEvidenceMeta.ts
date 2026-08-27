// The `meta.jira` shape stamped onto evidence rows by jiraCases.ts, plus the two lookups over
// it that `rca/input.ts` also needs. Split out of jiraCases.ts (Wave D, optional cleanup) so
// that reading ticket/comments evidence for RCA does not have to pull in the whole ticket
// service — Atlassian client, archive extraction, the `gh` runner, and everything else
// jiraCases.ts imports — just for two pure lookups over `EvidenceRecord[]`. No behavior
// changed by this split; jiraCases.ts re-exports both names so no other caller moves.
import type { EvidenceRecord } from '../../shared/types'

/** A ticket this evidence row's bytes are ALSO the attachment for, beyond the row's own
 *  `key`/`attachmentId`. Written when a dedup hit lands: the file was already ingested from
 *  one ticket and a byte-identical attachment then turned up on another (the overwhelmingly
 *  common case being a clone and the customer ticket it was cloned from — Jira clone does not
 *  copy attachments, but the same files are often re-attached to both independently). */
export interface JiraAlsoOn {
  key: string
  attachmentId: string
  filename: string
}

export interface JiraEvidenceMeta {
  key?: string
  role?: string
  status?: string
  attachmentId?: string
  filename?: string
  commentCount?: number
  alsoOn?: JiraAlsoOn[]
}

export const jiraMeta = (meta: Record<string, unknown>): JiraEvidenceMeta =>
  (meta.jira as JiraEvidenceMeta | undefined) ?? {}

/** Evidence lookup MUST be scoped by ticket key: a case can carry evidence from its primary
 *  ticket and from source tickets, and role alone is ambiguous across them. Used by both
 *  jiraCases.ts (every write site) and `rca/input.ts` (the read side), which reads the
 *  ticket/comments rows the same way `refresh` does — off `meta.jira.role`/`key` rather than a
 *  reconstructed filename, so it survives a rebind. */
export const findJiraEvidence = (
  evidence: EvidenceRecord[],
  role: string,
  key: string
): EvidenceRecord | undefined =>
  evidence.find((e) => jiraMeta(e.meta).role === role && jiraMeta(e.meta).key === key)
