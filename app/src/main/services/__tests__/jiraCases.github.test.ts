import { describe, it, expect, beforeEach, vi } from 'vitest'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import type { DatabaseSync } from 'node:sqlite'
import { openDb } from '../db'
import { getCase } from '../caseService'
import { listEvidence } from '../ingest'
import { createDetection } from '../packs/detection'
import { createImmediateQueue } from '../ingestQueue'
import { JiraCases } from '../jiraCases'
import { createGithubProvider } from '../tickets/githubProvider'
import { createJiraProvider } from '../tickets/jiraProvider'
import type { Runner } from '../github'

const ISSUE = {
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
  ]
}

let home: string
let db: DatabaseSync
let cases: JiraCases

beforeEach(() => {
  home = fs.mkdtempSync(path.join(os.tmpdir(), 'argus-home-'))
  db = openDb(path.join(home, 'argus.db'))
  const gh = vi.fn(async () => JSON.stringify(ISSUE)) as unknown as Runner
  const jiraClient = {
    getIssue: vi.fn(async () => {
      throw new Error('Atlassian must not be called for a GitHub case')
    }),
    getComments: vi.fn(async () => []),
    downloadAttachment: vi.fn(async () => undefined)
  }
  cases = new JiraCases({
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
})

function rebuild(payload: unknown): JiraCases {
  const gh = vi.fn(async () => JSON.stringify(payload)) as unknown as Runner
  const jiraClient = {
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

describe('createFromTicket — github', () => {
  it('creates a case bound to the GitHub issue', async () => {
    const rec = await cases.createFromTicket({
      slug: 'cli-14189',
      title: 'Tiles 403',
      key: 'cli/cli#14189'
    })
    expect(rec.ticketProvider).toBe('github')
    expect(rec.jiraKey).toBe('cli/cli#14189')
  })

  it('writes the ticket, raw and comments evidence', async () => {
    await cases.createFromTicket({ slug: 'cli-14189', title: 'Tiles 403', key: 'cli/cli#14189' })
    const names = listEvidence(db, 'cli-14189').map((e) => e.relPath)
    // The ref contains `/` and `#`, neither of which may reach a filename. `relPath` is
    // always `<topDir>/<filename>` (see evidenceScope.ts's dirForMode), so strip that one
    // structural separator before checking the ref-derived part of the name is clean.
    const filenames = names.map((n) => n.slice(n.indexOf('/') + 1))
    expect(filenames.some((n) => n.endsWith('.ticket.md'))).toBe(true)
    expect(filenames.some((n) => n.endsWith('.ticket.json'))).toBe(true)
    expect(filenames.some((n) => n.endsWith('.comments.md'))).toBe(true)
    expect(filenames.every((n) => !n.includes('/') && !n.includes('#'))).toBe(true)
  })

  it('seeds sync state from the fetched issue', async () => {
    await cases.createFromTicket({ slug: 'cli-14189', title: 'Tiles 403', key: 'cli/cli#14189' })
    const rec = getCase(db, 'cli-14189')!
    expect(rec.jiraStatus).toBe('open')
    expect(rec.jiraPriority).toBeNull()
    expect(rec.jiraCommentCount).toBe(1)
    expect(rec.jiraAttachmentIds).toEqual([])
  })
})

describe('preview — dispatch', () => {
  it('routes a GitHub ref to the GitHub provider without touching Atlassian', async () => {
    const p = await cases.preview('https://github.com/cli/cli/issues/14189')
    expect(p.provider).toBe('github')
    expect(p.key).toBe('cli/cli#14189')
  })

  it('surfaces the parser error for a pull request URL', async () => {
    await expect(cases.preview('https://github.com/cli/cli/pull/14222')).rejects.toThrow(
      /pull request, not an issue/i
    )
  })
})

describe('refresh — github', () => {
  it('updates status and counts new comments', async () => {
    await cases.createFromTicket({ slug: 'cli-14189', title: 'Tiles 403', key: 'cli/cli#14189' })
    const moved = {
      ...ISSUE,
      state: 'CLOSED',
      stateReason: 'NOT_PLANNED',
      comments: [
        ...ISSUE.comments,
        { id: 'c2', author: { login: 'bo' }, body: 'wontfix', createdAt: '2026-08-22T09:00:00Z' }
      ]
    }
    cases = rebuild(moved)
    const summary = await cases.refresh('cli-14189')
    expect(summary.statusChange).toEqual({ from: 'open', to: 'closed (not planned)' })
    expect(summary.newComments).toBe(1)
    expect(getCase(db, 'cli-14189')!.jiraStatus).toBe('closed (not planned)')
    expect(getCase(db, 'cli-14189')!.jiraCommentCount).toBe(2)
  })

  it('rebinds and reports when the issue was transferred', async () => {
    await cases.createFromTicket({ slug: 'cli-14189', title: 'Tiles 403', key: 'cli/cli#14189' })
    cases = rebuild({ ...ISSUE, number: 42, url: 'https://github.com/cli/go-gh/issues/42' })
    const summary = await cases.refresh('cli-14189')
    expect(summary.rebound).toEqual({ from: 'cli/cli#14189', to: 'cli/go-gh#42' })
    expect(getCase(db, 'cli-14189')!.jiraKey).toBe('cli/go-gh#42')
  })

  // Finding I1: refresh looks up existing evidence by the NEW canonical ref, but after a
  // transfer the existing rows still carry the OLD ref in meta.jira.key. Every lookup misses,
  // so the case forks — a stale ticket.md that never updates again, plus a fresh one — and the
  // comment-count diff silently re-reports the whole prior thread as new (oldCount reads 0).
  it('follows a transferred issue instead of forking its evidence', async () => {
    await cases.createFromTicket({ slug: 'cli-14189', title: 'Tiles 403', key: 'cli/cli#14189' })
    cases = rebuild({
      ...ISSUE,
      number: 42,
      url: 'https://github.com/cli/go-gh/issues/42',
      comments: [
        ...ISSUE.comments,
        { id: 'c2', author: { login: 'bo' }, body: 'moved here', createdAt: '2026-08-22T09:00:00Z' }
      ]
    })
    const summary = await cases.refresh('cli-14189')
    expect(summary.rebound).toEqual({ from: 'cli/cli#14189', to: 'cli/go-gh#42' })

    const evidence = listEvidence(db, 'cli-14189')
    const ticketFiles = evidence.filter((e) => e.relPath.endsWith('.ticket.md'))
    // Exactly one — not a stale row from the old ref plus a fresh one from the new ref.
    expect(ticketFiles).toHaveLength(1)
    const meta = ticketFiles[0].meta as { jira?: { key?: string } }
    expect(meta.jira?.key).toBe('cli/go-gh#42')

    // Computed against the prior count (1 comment before the transfer), not 0 — a missed
    // lookup would re-report the whole existing thread as new.
    expect(summary.newComments).toBe(1)
  })

  it('never calls Atlassian for a github-bound case', async () => {
    await cases.createFromTicket({ slug: 'cli-14189', title: 'Tiles 403', key: 'cli/cli#14189' })
    cases = rebuild(ISSUE)
    await expect(cases.refresh('cli-14189')).resolves.toBeDefined()
  })
})
