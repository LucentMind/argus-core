import fs from 'node:fs'
import path from 'node:path'
import type { DatabaseSync } from 'node:sqlite'
import type { CaseRcaInput, RcaDraft } from '../../../shared/rca'
import { DEFAULT_MODE } from '../../../shared/modes'
import { getCase } from '../caseService'
import { listFindings } from '../findings'
import { listEvidence } from '../ingest'
import { evidenceDir } from '../paths'

/** Tail cap per session; RCA needs the conclusion of a conversation, not its start. */
export const TRANSCRIPT_CAP = 8000

function readEvidenceFile(argusHome: string, slug: string, name: string): string | null {
  try {
    return fs.readFileSync(path.join(evidenceDir(argusHome, slug), name), 'utf8')
  } catch {
    return null
  }
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
    evidence: listEvidence(db, slug).map((e) => ({
      relPath: e.relPath,
      artifactType: e.artifactType,
      size: e.size
    })),
    jiraTicketMarkdown: c.jiraKey
      ? readEvidenceFile(argusHome, slug, `${c.jiraKey}.ticket.md`)
      : null,
    jiraCommentsMarkdown: c.jiraKey
      ? readEvidenceFile(argusHome, slug, `${c.jiraKey}.comments.md`)
      : null,
    transcripts,
    priorDraft
  }
}
