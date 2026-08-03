import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import type { DatabaseSync } from 'node:sqlite'
import { openDb } from '../db'
import { createCase, getCase } from '../caseService'
import { evidenceDir } from '../paths'
import { assembleRcaInput, TRANSCRIPT_CAP } from '../rca/input'

let home: string
let db: DatabaseSync

beforeEach(() => {
  home = fs.mkdtempSync(path.join(os.tmpdir(), 'argus-rca-input-'))
  db = openDb(path.join(home, 'argus.db'))
})

afterEach(() => {
  db.close()
  fs.rmSync(home, { recursive: true, force: true })
})

function insertSession(caseId: number, id: number, title: string, mode: string | null): void {
  if (mode === null) {
    db.prepare(
      `INSERT INTO sessions (id, case_id, title, turn_count, created_at, updated_at)
       VALUES (?, ?, ?, 0, '2026-01-01', '2026-01-01')`
    ).run(id, caseId, title)
  } else {
    db.prepare(
      `INSERT INTO sessions (id, case_id, title, turn_count, created_at, updated_at, mode)
       VALUES (?, ?, ?, 0, '2026-01-01', '2026-01-01', ?)`
    ).run(id, caseId, title, mode)
  }
}

function insertFinding(caseId: number, sessionId: number, summary: string): number {
  const r = db
    .prepare(
      `INSERT INTO findings (case_id, session_id, turn_id, summary, review_state, created_at)
       VALUES (?, ?, NULL, ?, 'accepted', '2026-01-01')`
    )
    .run(caseId, sessionId, summary)
  return Number(r.lastInsertRowid)
}

function indexMsg(
  caseId: number,
  sessionId: number,
  turnId: number,
  role: string,
  content: string
): void {
  db.prepare(
    `INSERT INTO messages_fts (content, case_id, session_id, turn_id, role) VALUES (?,?,?,?,?)`
  ).run(content, caseId, sessionId, turnId, role)
}

describe('assembleRcaInput', () => {
  it('includes only investigation findings, inlines ticket md, tails transcripts', () => {
    createCase(db, home, { slug: 'case-a', title: 'Case A', jiraKey: 'KAN-1' })
    const caseId = getCase(db, 'case-a')!.id

    insertSession(caseId, 1, 'Investigation chat', null) // defaults to 'investigation'
    insertSession(caseId, 2, 'Review chat', 'review')

    insertFinding(caseId, 1, 'Investigation finding')
    insertFinding(caseId, 2, 'Review finding')

    indexMsg(caseId, 1, 10, 'user', 'what broke here')
    indexMsg(caseId, 1, 11, 'assistant', 'assistant said this is the cause')
    indexMsg(caseId, 1, 12, 'tool', 'tool output noise')
    // review-session messages must never leak into transcripts
    indexMsg(caseId, 2, 20, 'user', 'review question')
    indexMsg(caseId, 2, 21, 'assistant', 'review answer')

    const dir = evidenceDir(home, 'case-a')
    fs.mkdirSync(dir, { recursive: true })
    fs.writeFileSync(path.join(dir, 'KAN-1.ticket.md'), '# KAN-1\n\nticket body text\n')
    fs.writeFileSync(path.join(dir, 'KAN-1.comments.md'), 'comment body text\n')

    const input = assembleRcaInput(db, home, 'case-a')

    expect(input.findings).toHaveLength(1)
    expect(input.findings[0].summary).toBe('Investigation finding')
    expect(input.jiraTicketMarkdown).toContain('ticket body text')
    expect(input.jiraCommentsMarkdown).toContain('comment body text')

    expect(input.transcripts).toHaveLength(1)
    expect(input.transcripts[0].title).toBe('Investigation chat')
    expect(input.transcripts[0].text).toContain('assistant said this')
    expect(input.transcripts[0].text).not.toContain('tool output noise')
    expect(input.transcripts[0].text).not.toContain('review question')
  })

  it('caps transcript text to the last TRANSCRIPT_CAP chars per session', () => {
    createCase(db, home, { slug: 'case-b', title: 'Case B' })
    const caseId = getCase(db, 'case-b')!.id
    insertSession(caseId, 1, 'Long chat', null)

    const filler = 'x'.repeat(TRANSCRIPT_CAP)
    indexMsg(caseId, 1, 1, 'user', filler)
    indexMsg(caseId, 1, 2, 'assistant', 'tail marker end')

    const input = assembleRcaInput(db, home, 'case-b')
    expect(input.transcripts).toHaveLength(1)
    const text = input.transcripts[0].text
    expect(text.length).toBeLessThanOrEqual(TRANSCRIPT_CAP)
    expect(text.endsWith('tail marker end')).toBe(true)
  })

  it('returns nulls for jira markdown when the case has no jiraKey', () => {
    createCase(db, home, { slug: 'case-c', title: 'Case C' })
    const input = assembleRcaInput(db, home, 'case-c')
    expect(input.jiraTicketMarkdown).toBeNull()
    expect(input.jiraCommentsMarkdown).toBeNull()
  })

  it('passes priorDraft through unchanged', () => {
    createCase(db, home, { slug: 'case-d', title: 'Case D' })
    const prior = {
      rootCause: { findingId: null, statement: 's', evidence: [] },
      contributing: [],
      symptoms: [],
      ruledOut: [],
      duplicates: [],
      impact: 'i',
      timeline: [],
      remediation: { immediate: 'now', followUps: [] },
      execSummary: { whatBroke: 'a', impact: 'b', why: 'c', nextSteps: 'd' },
      techNarrative: []
    }
    const input = assembleRcaInput(db, home, 'case-d', prior)
    expect(input.priorDraft).toBe(prior)
  })

  it('throws on unknown case', () => {
    expect(() => assembleRcaInput(db, home, 'nope')).toThrow(/Unknown case/)
  })
})
