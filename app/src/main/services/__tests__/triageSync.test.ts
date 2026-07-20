// Task 6: bulk sync — one action refreshes every open Jira-linked case, with
// bounded concurrency and per-case error isolation. Copies the setup helper
// pattern from jiraCases.test.ts rather than re-deriving it.
import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import type { DatabaseSync } from 'node:sqlite'
import { openDb } from '../db'
import { createDetection } from '../packs/detection'
import { samplePackRegistry, stubExtractors } from '../packs/__tests__/fixtures'
import { JiraCases, type AtlassianClientLike } from '../jiraCases'
import { createCase, getCase, listCases, setCaseStatus } from '../caseService'
import { AtlassianError } from '../atlassian'
import type { JiraCommentInfo, JiraIssuePreview } from '../../../shared/jira'
import type { JiraIssueData } from '../atlassian'

let tmp: string, argusHome: string, db: DatabaseSync
const detection = createDetection(samplePackRegistry())

function issueFor(key: string, status: string): JiraIssueData {
  const preview: JiraIssuePreview = {
    key,
    summary: `summary for ${key}`,
    status,
    priority: null,
    labels: [],
    reporter: null,
    created: '2026-07-01T00:00:00Z',
    updated: '2026-07-01T00:00:00Z',
    attachments: [
      { id: `${key}-a1`, filename: 'a.txt', size: 1, mimeType: 'text/plain', createdAt: '' },
      { id: `${key}-a2`, filename: 'b.txt', size: 1, mimeType: 'text/plain', createdAt: '' }
    ]
  }
  return { preview, descriptionMarkdown: 'desc', raw: { key, fields: {} } }
}

/**
 * Fake client instrumented for concurrency observation. `getIssue` doesn't
 * resolve until a later tick (an explicit setTimeout(0)), so overlapping
 * in-flight calls actually overlap in time — a fully-serial implementation
 * would never push `maxConcurrent` above 1. `inFlight` is incremented on
 * entry and decremented on settle (success or failure) via `finally`.
 */
interface FakeClient extends AtlassianClientLike {
  issueKeys: string[]
  maxConcurrent: number
  downloadAttachmentCalls: number
  failFor: (key: string, err: Error) => void
  clearFailures: () => void
  setStatus: (key: string, status: string) => void
}

function fakeClient(): FakeClient {
  const failures = new Map<string, Error>()
  const statuses = new Map<string, string>()
  let inFlight = 0

  const client: FakeClient = {
    issueKeys: [],
    maxConcurrent: 0,
    downloadAttachmentCalls: 0,
    async getIssue(key: string): Promise<JiraIssueData> {
      client.issueKeys.push(key)
      inFlight++
      client.maxConcurrent = Math.max(client.maxConcurrent, inFlight)
      try {
        await new Promise((r) => setTimeout(r, 0))
        const err = failures.get(key)
        if (err) throw err
        return issueFor(key, statuses.get(key) ?? 'Open')
      } finally {
        inFlight--
      }
    },
    async downloadAttachment(): Promise<void> {
      // syncAll must never reach this: it only reports new attachments for the
      // renderer's per-case dialog to ingest. A count > 0 means a regression.
      client.downloadAttachmentCalls++
    },
    async getComments(): Promise<JiraCommentInfo[]> {
      return []
    },
    failFor(key: string, err: Error): void {
      failures.set(key, err)
    },
    clearFailures(): void {
      failures.clear()
    },
    setStatus(key: string, status: string): void {
      statuses.set(key, status)
    }
  }
  return client
}

function service(client: AtlassianClientLike): JiraCases {
  return new JiraCases({
    db,
    argusHome,
    detection,
    client,
    site: () => 'https://acme.atlassian.net',
    extractors: stubExtractors('binlog'),
    emitProgress: () => {},
    evidenceChanged: () => {},
    parsing: () => {}
  })
}

function setup(): { svc: JiraCases; db: DatabaseSync; home: string; client: FakeClient } {
  const client = fakeClient()
  return { svc: service(client), db, home: argusHome, client }
}

beforeEach(() => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'argus-triage-sync-'))
  argusHome = path.join(tmp, 'home')
  db = openDb(path.join(argusHome, 'argus.db'))
})

afterEach(() => {
  db.close()
  fs.rmSync(tmp, { recursive: true, force: true })
})

describe('syncAll', () => {
  it('syncs every non-closed case with a jira key', async () => {
    const { svc, db, home, client } = setup()
    createCase(db, home, { slug: 'a', title: 'a', jiraKey: 'P-1' })
    createCase(db, home, { slug: 'b', title: 'b', jiraKey: 'P-2' })
    createCase(db, home, { slug: 'no-key', title: 'c' })
    setCaseStatus(db, home, 'b', 'closed', 'solved')

    const r = await svc.syncAll()
    expect(r.total).toBe(1)
    expect(r.synced).toBe(1)
    expect(client.issueKeys).toEqual(['P-1'])
  })

  it('isolates a failure — one bad case does not abort the run', async () => {
    const { svc, db, home, client } = setup()
    createCase(db, home, { slug: 'good', title: 'g', jiraKey: 'P-1' })
    createCase(db, home, { slug: 'bad', title: 'b', jiraKey: 'P-2' })
    client.failFor('P-2', new AtlassianError('auth', 'rejected'))

    const r = await svc.syncAll()
    expect(r.synced).toBe(1)
    expect(r.failed).toBe(1)
    expect(getCase(db, 'good')!.lastSyncError).toBeNull()
    // prove the good case genuinely synced, not merely that a count says 1
    expect(getCase(db, 'good')!.jiraStatus).toBe('Open')
    expect(getCase(db, 'good')!.jiraSyncedAt).not.toBeNull()
    expect(getCase(db, 'bad')!.lastSyncError).toMatchObject({ code: 'auth' })
  })

  it('preserves last-known-good fields on a failed case', async () => {
    const { svc, db, home, client } = setup()
    createCase(db, home, { slug: 'x', title: 'x', jiraKey: 'P-1' })
    client.setStatus('P-1', 'In Progress')
    await svc.syncAll()
    const before = getCase(db, 'x')!.jiraStatus
    expect(before).toBe('In Progress') // establish a real, non-null value first
    client.failFor('P-1', new AtlassianError('network', 'down'))
    await svc.syncAll()
    expect(getCase(db, 'x')!.jiraStatus).toBe(before)
    expect(getCase(db, 'x')!.lastSyncError).toMatchObject({ code: 'network' })
  })

  it('clears a stale error on a later success', async () => {
    const { svc, db, home, client } = setup()
    createCase(db, home, { slug: 'x', title: 'x', jiraKey: 'P-1' })
    client.failFor('P-1', new AtlassianError('network', 'down'))
    await svc.syncAll()
    client.clearFailures()
    await svc.syncAll()
    expect(getCase(db, 'x')!.lastSyncError).toBeNull()
  })

  it('counts cases whose upstream changed', async () => {
    const { svc, db, home, client } = setup()
    createCase(db, home, { slug: 'x', title: 'x', jiraKey: 'P-1' })
    await svc.syncAll()
    svc.markReviewed('x')
    client.setStatus('P-1', 'Done')
    const r = await svc.syncAll()
    expect(r.changed).toBe(1)
  })

  it('does not count failed cases as changed — a total outage reports changed: 0', async () => {
    const { svc, db, home, client } = setup()
    createCase(db, home, { slug: 'a', title: 'a', jiraKey: 'P-1' })
    createCase(db, home, { slug: 'b', title: 'b', jiraKey: 'P-2' })
    createCase(db, home, { slug: 'c', title: 'c', jiraKey: 'P-3' })
    client.failFor('P-1', new AtlassianError('network', 'down'))
    client.failFor('P-2', new AtlassianError('network', 'down'))
    client.failFor('P-3', new AtlassianError('network', 'down'))

    const r = await svc.syncAll()
    expect(r.total).toBe(3)
    expect(r.synced).toBe(0)
    expect(r.failed).toBe(3)
    // Every failed case now carries a sync-error action item (from its own
    // lastSyncError), but that is a failure being reported, not a change.
    expect(listCases(db).find((c) => c.slug === 'a')!.actionItems.length).toBeGreaterThan(0)
    expect(r.changed).toBe(0)
  })

  it('changed counts only the succeeded case in a mix of one success, one failure', async () => {
    const { svc, db, home, client } = setup()
    createCase(db, home, { slug: 'ok', title: 'ok', jiraKey: 'P-1' })
    createCase(db, home, { slug: 'bad', title: 'bad', jiraKey: 'P-2' })
    await svc.syncAll()
    svc.markReviewed('ok')
    svc.markReviewed('bad')
    // give 'ok' a real upstream change to pick up on the next sync
    client.setStatus('P-1', 'Done')
    client.failFor('P-2', new AtlassianError('network', 'down'))

    const r = await svc.syncAll()
    expect(r.synced).toBe(1)
    expect(r.failed).toBe(1)
    const cases = listCases(db)
    expect(cases.find((c) => c.slug === 'ok')!.actionItems.length).toBeGreaterThan(0)
    expect(cases.find((c) => c.slug === 'bad')!.actionItems.length).toBeGreaterThan(0)
    expect(r.changed).toBe(1)
  })

  it('survives a throwing onProgress callback — the run still completes every case', async () => {
    const { svc, db, home } = setup()
    createCase(db, home, { slug: 'a', title: 'a', jiraKey: 'P-1' })
    createCase(db, home, { slug: 'b', title: 'b', jiraKey: 'P-2' })
    createCase(db, home, { slug: 'c', title: 'c', jiraKey: 'P-3' })
    let calls = 0
    const r = await svc.syncAll(() => {
      calls++
      if (calls === 1) throw new Error('renderer window destroyed')
    })
    expect(r.total).toBe(3)
    expect(r.synced).toBe(3)
    expect(r.failed).toBe(0)
    // assert persisted state, not just the counters
    expect(getCase(db, 'a')!.jiraSyncedAt).not.toBeNull()
    expect(getCase(db, 'b')!.jiraSyncedAt).not.toBeNull()
    expect(getCase(db, 'c')!.jiraSyncedAt).not.toBeNull()
  })

  it('survives onProgress throwing a non-Error (null) — the run still completes', async () => {
    const { svc, db, home } = setup()
    createCase(db, home, { slug: 'a', title: 'a', jiraKey: 'P-1' })
    createCase(db, home, { slug: 'b', title: 'b', jiraKey: 'P-2' })
    let calls = 0
    const r = await svc.syncAll(() => {
      calls++
      if (calls === 1) throw null
    })
    expect(r.total).toBe(2)
    expect(r.synced).toBe(2)
    expect(r.failed).toBe(0)
    // assert persisted state, not just the counters
    expect(getCase(db, 'a')!.jiraSyncedAt).not.toBeNull()
    expect(getCase(db, 'b')!.jiraSyncedAt).not.toBeNull()
  })

  it('never runs more than the concurrency limit at once', async () => {
    const { svc, db, home, client } = setup()
    for (let i = 0; i < 10; i++) {
      createCase(db, home, { slug: `c${i}`, title: `c${i}`, jiraKey: `P-${i}` })
    }
    await svc.syncAll()
    expect(client.maxConcurrent).toBeLessThanOrEqual(4)
    // a fully-serial implementation would never exceed 1 — assert real overlap happened
    expect(client.maxConcurrent).toBeGreaterThan(1)
  })

  it('reports progress as it goes', async () => {
    const { svc, db, home } = setup()
    createCase(db, home, { slug: 'a', title: 'a', jiraKey: 'P-1' })
    createCase(db, home, { slug: 'b', title: 'b', jiraKey: 'P-2' })
    const seen: number[] = []
    await svc.syncAll((done, total) => {
      expect(total).toBe(2)
      seen.push(done)
    })
    expect(seen).toEqual([1, 2])
  })

  it('never downloads attachments', async () => {
    const { svc, db, home, client } = setup()
    createCase(db, home, { slug: 'a', title: 'a', jiraKey: 'P-1' })
    // the issue fixture carries real attachments (see issueFor) — a sync that
    // downloaded them would show up here, not just in a passing synced count
    await expect(svc.syncAll()).resolves.toMatchObject({ synced: 1 })
    expect(client.downloadAttachmentCalls).toBe(0)
  })
})
