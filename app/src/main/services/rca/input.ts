import fs from 'node:fs'
import path from 'node:path'
import type { DatabaseSync } from 'node:sqlite'
import type { CaseRcaInput, RcaDraft } from '../../../shared/rca'
import { DEFAULT_MODE } from '../../../shared/modes'
import type { EvidenceRecord } from '../../../shared/types'
import { getCase } from '../caseService'
import { listFindings } from '../findings'
import { listEvidence } from '../ingest'
import { caseDir } from '../paths'
import { findJiraEvidence, jiraMeta } from '../jiraEvidenceMeta'

/** Tail cap per session; RCA needs the conclusion of a conversation, not its start. */
export const TRANSCRIPT_CAP = 8000

/** Read a specific evidence row's bytes off its own `relPath` — never a reconstructed
 *  filename, so this survives a transfer that changed the case's ticket key without renaming
 *  the file on disk (see Finding C1-follow-up). `relPath` is already case-relative
 *  (`evidence/xxx.ticket.md`), matching how `ingest.ts` resolves it elsewhere. */
function readEvidenceRow(argusHome: string, slug: string, rec: EvidenceRecord): string | null {
  try {
    return fs.readFileSync(path.join(caseDir(argusHome, slug), ...rec.relPath.split('/')), 'utf8')
  } catch {
    return null
  }
}

/** Locate this case's ticket/comments evidence the way `refresh` does — off `meta.jira.role`
 *  scoped by `key` — and read it by `relPath`.
 *
 *  Falls back to a ROLE-ONLY match (ignoring `key` entirely) when the scoped lookup misses.
 *  `refresh` writes `cases.jira_key` and migrates existing rows' `meta.jira.key` in two
 *  separate statements; an exception between them leaves rows migrated to a newer ref than
 *  the case record still names. A case transferred a SECOND time before that gap is noticed
 *  compounds it: `migrateJiraKey`'s `from` no longer matches the row's already-migrated key,
 *  so the row is skipped again, and `c.jiraKey` (used here) can be two refs behind the row's
 *  actual `meta.jira.key`. Roles `ticket`/`comments` are exclusive to the primary ticket —
 *  `importSourceTicket` always writes the distinct roles `source-ticket`/`source-ticket-raw`/
 *  `source-comments` — so a role-only match here can never return a source ticket's text.
 *
 *  No legacy-filename fallback: every production write goes through `ingestContent`/
 *  `ingestArtifact`, which insert the DB row atomically with the file write, so an evidence
 *  file with no matching row cannot occur outside a hand-rolled test fixture. */
function readTicketEvidence(
  argusHome: string,
  slug: string,
  key: string,
  evidence: EvidenceRecord[],
  role: 'ticket' | 'comments'
): string | null {
  const rec = findJiraEvidence(evidence, role, key)
  if (rec) return readEvidenceRow(argusHome, slug, rec)
  const roleOnly = evidence.find((e) => jiraMeta(e.meta).role === role)
  if (roleOnly) return readEvidenceRow(argusHome, slug, roleOnly)
  return null
}

/**
 * Snapshot everything a headless RCA job needs to draft a case's root-cause report: case
 * meta, investigation-mode findings (with role, for linking claims to earlier triage
 * conclusions), the investigation evidence inventory, inlined Jira ticket/comments
 * markdown when the case is linked, and the tail of each investigation session's
 * user/assistant chat text. Review-mode material (sessions, findings, `artifacts/`
 * evidence) never enters this snapshot — RCA reasons over the investigation only.
 */
export function assembleRcaInput(
  db: DatabaseSync,
  argusHome: string,
  slug: string,
  priorDraft: RcaDraft | null = null
): CaseRcaInput {
  const c = getCase(db, slug)
  if (!c) throw new Error(`Unknown case: ${slug}`)

  const sessions = db
    .prepare(
      `SELECT id, title FROM sessions WHERE case_id = ? AND COALESCE(mode, ?) = ? ORDER BY id ASC`
    )
    .all(c.id, DEFAULT_MODE, DEFAULT_MODE) as { id: number; title: string }[]

  const transcripts = sessions
    .map((s) => {
      const rows = db
        .prepare(
          `SELECT content, role FROM messages_fts
           WHERE case_id = ? AND session_id = ? AND role IN ('user','assistant')
           ORDER BY rowid ASC`
        )
        .all(c.id, s.id) as { content: string; role: string }[]
      const text = rows.map((r) => `${r.role}: ${r.content}`).join('\n')
      return { title: s.title, text: text.slice(-TRANSCRIPT_CAP) }
    })
    // A session with no user/assistant traffic (created but never chatted in) contributes
    // nothing — dropping it keeps the RCA prompt from padding on empty transcripts.
    .filter((t) => t.text.length > 0)

  const evidenceRows = listEvidence(db, slug)

  return {
    caseMeta: {
      slug: c.slug,
      title: c.title,
      jiraKey: c.jiraKey,
      resolution: c.resolution,
      tags: c.tags,
      createdAt: c.createdAt,
      ticketProvider: c.ticketProvider
    },
    findings: listFindings(db, argusHome, slug)
      .filter((f) => f.mode === DEFAULT_MODE)
      .map((f) => ({
        id: f.id,
        summary: f.summary,
        body: f.body ?? '',
        reviewState: f.reviewState,
        reviewReason: f.reviewReason,
        reviewActor: f.reviewActor,
        role: f.role
      })),
    evidence: evidenceRows.map((e) => ({
      relPath: e.relPath,
      artifactType: e.artifactType,
      size: e.size
    })),
    jiraTicketMarkdown: c.jiraKey
      ? readTicketEvidence(argusHome, slug, c.jiraKey, evidenceRows, 'ticket')
      : null,
    jiraCommentsMarkdown: c.jiraKey
      ? readTicketEvidence(argusHome, slug, c.jiraKey, evidenceRows, 'comments')
      : null,
    transcripts,
    priorDraft
  }
}
