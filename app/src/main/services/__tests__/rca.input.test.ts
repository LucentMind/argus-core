import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import type { DatabaseSync } from 'node:sqlite'
import { openDb } from '../db'
import { createCase, getCase } from '../caseService'
import { evidenceDir } from '../paths'
import { assembleRcaInput, TRANSCRIPT_CAP } from '../rca/input'
import { JiraCases, type AtlassianClientLike } from '../jiraCases'
import { createDetection } from '../packs/detection'
import { createImmediateQueue } from '../ingestQueue'
import { createGithubProvider } from '../tickets/githubProvider'
import { createJiraProvider } from '../tickets/jiraProvider'
import type { Runner } from '../github'
import type { JiraIssuePreview } from '../../../shared/jira'
import type { JiraIssueData } from '../atlassian'

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
      techNarrative: [],
      sections: {}
    }
    const input = assembleRcaInput(db, home, 'case-d', prior)
    expect(input.priorDraft).toBe(prior)
  })

  it('throws on unknown case', () => {
    expect(() => assembleRcaInput(db, home, 'nope')).toThrow(/Unknown case/)
  })

  // Finding C1: a GitHub ref (`owner/repo#123`) carries `/` and `#`, which the write side
  // (jiraCases.ts) slugs away via refSlug before naming the evidence file on disk. The read
  // side here must build the SAME filename from the SAME helper, or it silently misses the
  // file `readEvidenceFile`'s catch swallows the miss into `null`, and RCA is drafted with
  // no issue body and no comments at all.
  it('inlines ticket/comments markdown for a GitHub-bound case', () => {
    createCase(db, home, {
      slug: 'case-gh',
      title: 'Case GH',
      jiraKey: 'cli/cli#14189',
      ticketProvider: 'github'
    })
    const dir = evidenceDir(home, 'case-gh')
    fs.mkdirSync(dir, { recursive: true })
    fs.writeFileSync(path.join(dir, 'cli-cli-14189.ticket.md'), '# cli/cli#14189\n\nissue body\n')
    fs.writeFileSync(path.join(dir, 'cli-cli-14189.comments.md'), 'comment body\n')

    const input = assembleRcaInput(db, home, 'case-gh')

    expect(input.jiraTicketMarkdown).not.toBeNull()
    expect(input.jiraCommentsMarkdown).not.toBeNull()
    expect(input.jiraTicketMarkdown).toContain('issue body')
    expect(input.jiraCommentsMarkdown).toContain('comment body')
  })

  // Finding C1-follow-up: the hand-written-file test above only ever exercises the READ
  // side, so it can't catch a write/read disagreement — which is the entire defect class.
  // These go through the real write path (JiraCases) end to end.

  function githubIssue(over: Record<string, unknown> = {}): Record<string, unknown> {
    return {
      number: 14189,
      title: 'Tiles 403 on OEM head unit',
      body: 'Repro: open the map.',
      state: 'OPEN',
      stateReason: '',
      author: { login: 'mislav' },
      createdAt: '2026-08-19T10:00:00Z',
      updatedAt: '2026-08-21T17:56:37Z',
      labels: [{ name: 'bug' }],
      url: 'https://github.com/cli/cli/issues/14189',
      closedByPullRequestsReferences: [],
      comments: [
        {
          id: 'c1',
          author: { login: 'ana' },
          body: 'Also seen on v2.',
          createdAt: '2026-08-20T09:00:00Z'
        }
      ],
      ...over
    }
  }

  function githubCases(payload: Record<string, unknown>): JiraCases {
    const gh = vi.fn(async () => JSON.stringify(payload)) as unknown as Runner
    const jiraClient: AtlassianClientLike = {
      getIssue: vi.fn(async () => {
        throw new Error('Atlassian must not be called for a GitHub case')
      }),
      getComments: vi.fn(async () => []),
      downloadAttachment: vi.fn(async () => undefined)
    }
    return new JiraCases({
      db,
      argusHome: home,
      detection: createDetection(),
      client: jiraClient,
      site: () => 'https://argus88.atlassian.net',
      queue: createImmediateQueue(db, home),
      emitProgress: () => {},
      evidenceChanged: () => {},
      providers: {
        jira: createJiraProvider({
          client: jiraClient,
          site: () => 'https://argus88.atlassian.net',
          postComment: async () => undefined
        }),
        github: createGithubProvider({ gh })
      }
    })
  }

  function jiraIssue(key: string, over: Partial<JiraIssuePreview> = {}): JiraIssueData {
    const preview: JiraIssuePreview = {
      key,
      summary: 'Route flickers',
      status: 'Open',
      priority: null,
      labels: ['nav'],
      reporter: 'Ada',
      created: 'c',
      updated: 'u',
      attachments: [],
      cloneLinks: [],
      ...over
    }
    return { preview, descriptionMarkdown: 'desc body', raw: { key: preview.key, fields: {} } }
  }

  function jiraCasesFor(client: AtlassianClientLike): JiraCases {
    const site = (): string => 'https://acme.atlassian.net'
    return new JiraCases({
      db,
      argusHome: home,
      detection: createDetection(),
      client,
      site,
      queue: createImmediateQueue(db, home),
      emitProgress: () => {},
      evidenceChanged: () => {},
      providers: {
        jira: createJiraProvider({ client, site, postComment: async () => undefined }),
        github: createGithubProvider({})
      }
    })
  }

  it('end-to-end: a GitHub case created via createFromTicket has non-null ticket/comments markdown', async () => {
    const svc = githubCases(githubIssue())
    await svc.createFromTicket({ slug: 'cli-14189', title: 'Tiles 403', key: 'cli/cli#14189' })

    const input = assembleRcaInput(db, home, 'cli-14189')
    expect(input.jiraTicketMarkdown).not.toBeNull()
    expect(input.jiraCommentsMarkdown).not.toBeNull()
    expect(input.jiraTicketMarkdown).toContain('Repro: open the map.')
    expect(input.jiraCommentsMarkdown).toContain('Also seen on v2.')
  })

  it('end-to-end: ticket/comments markdown survives a GitHub issue transfer to another repo', async () => {
    let svc = githubCases(githubIssue())
    await svc.createFromTicket({ slug: 'cli-14189', title: 'Tiles 403', key: 'cli/cli#14189' })

    svc = githubCases(
      githubIssue({
        number: 42,
        url: 'https://github.com/cli/go-gh/issues/42',
        title: 'Moved: tiles 403'
      })
    )
    const summary = await svc.refresh('cli-14189')
    expect(summary.rebound).toEqual({ from: 'cli/cli#14189', to: 'cli/go-gh#42' })
    expect(getCase(db, 'cli-14189')!.jiraKey).toBe('cli/go-gh#42')

    const input = assembleRcaInput(db, home, 'cli-14189')
    expect(input.jiraTicketMarkdown).not.toBeNull()
    expect(input.jiraCommentsMarkdown).not.toBeNull()
    expect(input.jiraTicketMarkdown).toContain('Repro: open the map.')
    expect(input.jiraCommentsMarkdown).toContain('Also seen on v2.')
  })

  // This is a regression on the must-not-change path, not a new GitHub behaviour: a Jira
  // issue moved between projects (KAN-17 -> OPS-5) hits the exact same defect.
  it('end-to-end: ticket/comments markdown survives a Jira issue key move (KAN-17 -> OPS-5)', async () => {
    const client: AtlassianClientLike = {
      getIssue: vi.fn(async () => jiraIssue('KAN-17', { summary: 'Route flickers' })),
      downloadAttachment: vi.fn(async () => undefined),
      getComments: vi.fn(async () => [
        {
          id: 'c1',
          author: 'Ada',
          bodyMarkdown: 'seen it too',
          created: '2026-08-01T00:00:00Z',
          updated: '2026-08-01T00:00:00Z'
        }
      ])
    }
    let svc = jiraCasesFor(client)
    await svc.createFromTicket({ slug: 'nav-1', title: 'T', key: 'KAN-17' })

    const movedClient: AtlassianClientLike = {
      ...client,
      getIssue: vi.fn(async () => jiraIssue('OPS-5', { summary: 'Route flickers (moved)' }))
    }
    svc = jiraCasesFor(movedClient)
    const summary = await svc.refresh('nav-1')
    expect(summary.rebound).toEqual({ from: 'KAN-17', to: 'OPS-5' })
    expect(getCase(db, 'nav-1')!.jiraKey).toBe('OPS-5')

    const input = assembleRcaInput(db, home, 'nav-1')
    expect(input.jiraTicketMarkdown).not.toBeNull()
    expect(input.jiraCommentsMarkdown).not.toBeNull()
    expect(input.jiraTicketMarkdown).toContain('Route flickers')
    expect(input.jiraCommentsMarkdown).toContain('seen it too')
  })

  // Wave D, Minor 1: `refresh` commits the metadata migration (`migrateJiraKey`) before it
  // writes `cases.jira_key`. An exception between those two statements leaves evidence rows
  // migrated to a newer ref than the case record still names. A SECOND transfer before that
  // gap is fixed compounds it — `migrateJiraKey`'s `from` no longer matches the row's
  // already-migrated key, so it's skipped again, and `c.jiraKey` ends up two refs behind the
  // row's real `meta.jira.key`. The exact-match lookup (role+key) misses under that drift,
  // and so does the legacy filename fallback (which is keyed off the same stale `c.jiraKey`
  // and would look for a file that was never written under that name). This simulates the
  // drift directly against the DB — a real refresh cannot land in this state without an
  // injected failure, which isn't what this test is proving — and asserts the ticket and
  // comments text still resolve via a role-only match.
  it('resolves ticket/comments evidence when meta.jira.key and cases.jira_key have both drifted out of sync', async () => {
    const svc = githubCases(githubIssue())
    await svc.createFromTicket({ slug: 'cli-14189', title: 'Tiles 403', key: 'cli/cli#14189' })

    // Simulate one completed-but-half-committed migration (meta moved on) plus a second
    // transfer noticed by the case record but never reconciled against the evidence rows.
    const caseId = getCase(db, 'cli-14189')!.id
    const rows = db.prepare(`SELECT id, meta FROM evidence WHERE case_id = ?`).all(caseId) as {
      id: number
      meta: string
    }[]
    for (const row of rows) {
      const meta = JSON.parse(row.meta) as { jira?: { key?: string } }
      if (meta.jira?.key === 'cli/cli#14189') {
        meta.jira.key = 'cli/cli#20000'
        db.prepare(`UPDATE evidence SET meta = ? WHERE id = ?`).run(JSON.stringify(meta), row.id)
      }
    }
    db.prepare(`UPDATE cases SET jira_key = ? WHERE id = ?`).run('cli/cli#99999', caseId)

    // Neither the exact metadata match nor the legacy filename fallback can find this row:
    // the row's key is now 'cli/cli#20000', the case's key is 'cli/cli#99999', and the file
    // on disk is still named for the ORIGINAL ref ('cli-cli-14189.ticket.md').
    const input = assembleRcaInput(db, home, 'cli-14189')
    expect(input.jiraTicketMarkdown).not.toBeNull()
    expect(input.jiraCommentsMarkdown).not.toBeNull()
    expect(input.jiraTicketMarkdown).toContain('Repro: open the map.')
    expect(input.jiraCommentsMarkdown).toContain('Also seen on v2.')
  })
})
