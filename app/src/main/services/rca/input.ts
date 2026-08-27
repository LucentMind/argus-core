import fs from 'node:fs'
import path from 'node:path'
import type { DatabaseSync } from 'node:sqlite'
import type { CaseRcaInput, RcaDraft } from '../../../shared/rca'
import { DEFAULT_MODE } from '../../../shared/modes'
import type { EvidenceRecord } from '../../../shared/types'
import { getCase } from '../caseService'
import { listFindings } from '../findings'
import { listEvidence } from '../ingest'
import { caseDir, evidenceDir } from '../paths'
import { refSlug } from '../../../shared/ticketRef'
import { findJiraEvidence } from '../jiraCases'

/** Tail cap per session; RCA needs the conclusion of a conversation, not its start. */
export const TRANSCRIPT_CAP = 8000

function readEvidenceFile(argusHome: string, slug: string, name: string): string | null {
  try {
    return fs.readFileSync(path.join(evidenceDir(argusHome, slug), name), 'utf8')
  } catch {
    return null
  }
}

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
 *  scoped by `key` — and read it by `relPath`. Falls back to the legacy filename convention
 *  (`${refSlug(key)}.<role-suffix>`) only when no row carries the matching metadata, which
 *  covers evidence ingested before this metadata existed; ordinary, never-transferred cases
 *  always resolve via metadata since every write site sets it. */
function readTicketEvidence(
  argusHome: string,
  slug: string,
  key: string,
  evidence: EvidenceRecord[],
  role: 'ticket' | 'comments',
  legacySuffix: 'ticket.md' | 'comments.md'
): string | null {
  const rec = findJiraEvidence(evidence, role, key)
  if (rec) return readEvidenceRow(argusHome, slug, rec)
  return readEvidenceFile(argusHome, slug, `${refSlug(key)}.${legacySuffix}`)
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
      createdAt: c.createdAt
    },
    findings: listFindings(db, argusHome, slug)
      .filter((f) => f.mode === DEFAULT_MODE)
      .map((f) => ({
        id: f.id,
        summary: f.summary,
        body: f.body ?? '',
        reviewState: f.reviewState,
        role: f.role
      })),
    evidence: evidenceRows.map((e) => ({
      relPath: e.relPath,
      artifactType: e.artifactType,
      size: e.size
    })),
    jiraTicketMarkdown: c.jiraKey
      ? readTicketEvidence(argusHome, slug, c.jiraKey, evidenceRows, 'ticket', 'ticket.md')
      : null,
    jiraCommentsMarkdown: c.jiraKey
      ? readTicketEvidence(argusHome, slug, c.jiraKey, evidenceRows, 'comments', 'comments.md')
      : null,
    transcripts,
    priorDraft
  }
}
