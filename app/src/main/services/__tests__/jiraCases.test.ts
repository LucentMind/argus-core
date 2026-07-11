import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import type { DatabaseSync } from 'node:sqlite'
import { openDb } from '../db'
import { caseDir } from '../paths'
import { listEvidence } from '../ingest'
import { createDetection } from '../packs/detection'
import { samplePackRegistry } from '../packs/__tests__/fixtures'
import { JiraCases, type AtlassianClientLike } from '../jiraCases'
import type { JiraAttachmentProgress, JiraIssuePreview } from '../../../shared/jira'
import type { JiraIssueData } from '../atlassian'

let tmp: string, argusHome: string, db: DatabaseSync
let progress: JiraAttachmentProgress[]
let changed: string[]
const detection = createDetection(samplePackRegistry())

const att = (id: string, filename: string): JiraIssuePreview['attachments'][number] => ({
  id,
  filename,
  size: 9,
  mimeType: 'text/plain',
  createdAt: '2026-07-02T00:00:00Z'
})

function issue(over: Partial<JiraIssuePreview> = {}): JiraIssueData {
  const preview: JiraIssuePreview = {
    key: 'NAV-7',
    summary: 'Route flickers',
    status: 'Open',
    labels: ['nav'],
    reporter: 'Ada',
    created: 'c',
    updated: 'u',
    attachments: [att('10001', 'log.txt')],
    ...over
  }
  return { preview, descriptionMarkdown: 'desc body', raw: { key: preview.key, fields: {} } }
}

function fakeClient(
  data: () => JiraIssueData,
  failIds: Set<string> = new Set()
): AtlassianClientLike {
  return {
    getIssue: vi.fn(async () => data()),
    downloadAttachment: vi.fn(async (id: string, dest: string) => {
      if (failIds.has(id)) throw new Error(`download failed: ${id}`)
      fs.writeFileSync(dest, `bytes-of-${id}`)
    })
  }
}

function service(
  client: AtlassianClientLike,
  onParsing?: (evidenceId: number, active: boolean) => void
): JiraCases {
  return new JiraCases({
    db,
    argusHome,
    detection,
    client,
    site: () => 'https://acme.atlassian.net',
    argusParse: () => null,
    emitProgress: (p) => progress.push(p),
    evidenceChanged: (slug) => changed.push(slug),
    parsing: (_slug, evidenceId, active) => onParsing?.(evidenceId, active)
  })
}

beforeEach(() => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'argus-jira-'))
  argusHome = path.join(tmp, 'home')
  db = openDb(path.join(argusHome, 'argus.db'))
  progress = []
  changed = []
})

afterEach(() => {
  db.close()
  fs.rmSync(tmp, { recursive: true, force: true })
})

describe('JiraCases.createFromTicket', () => {
  it('creates the case, stores ticket md + raw json as jira evidence, links case.json', async () => {
    const svc = service(fakeClient(() => issue()))
    const rec = await svc.createFromTicket({ slug: 'NAV-7', title: 'Route flickers', key: 'NAV-7' })
    expect(rec.jiraKey).toBe('NAV-7')

    const ev = listEvidence(db, 'NAV-7')
    const md = ev.find((e) => e.relPath === 'evidence/NAV-7.ticket.md')!
    const raw = ev.find((e) => e.relPath === 'evidence/NAV-7.ticket.json')!
    expect(md.origin).toBe('jira')
    expect((md.meta.jira as { role: string }).role).toBe('ticket')
    expect((raw.meta.jira as { role: string }).role).toBe('ticket-raw')
    const body = fs.readFileSync(
      path.join(caseDir(argusHome, 'NAV-7'), 'evidence', 'NAV-7.ticket.md'),
      'utf8'
    )
    expect(body).toContain('# NAV-7: Route flickers')
    expect(body).toContain('desc body')
    // FTS-indexed
    const hit = db
      .prepare(`SELECT count(*) c FROM evidence_fts WHERE evidence_fts MATCH 'flickers'`)
      .get() as { c: number }
    expect(hit.c).toBeGreaterThan(0)
    // case.json linked
    const cj = JSON.parse(
      fs.readFileSync(path.join(caseDir(argusHome, 'NAV-7'), 'case.json'), 'utf8')
    )
    expect(cj.jira).toMatchObject({ key: 'NAV-7', site: 'https://acme.atlassian.net' })
  })
})

describe('JiraCases.ingestAttachments', () => {
  it('downloads + ingests with provenance, emits per-file progress, fires evidenceChanged', async () => {
    const svc = service(fakeClient(() => issue()))
    await svc.createFromTicket({ slug: 'NAV-7', title: 't', key: 'NAV-7' })
    const results = await svc.ingestAttachments('NAV-7', [att('10001', 'log.txt')])
    expect(results).toHaveLength(1)
    expect(results[0]).toMatchObject({ attachmentId: '10001', status: 'done' })
    expect(progress.map((p) => p.status)).toEqual(['downloading', 'done'])
    const ev = listEvidence(db, 'NAV-7').find((e) => e.relPath === 'evidence/log.txt')!
    expect(ev.origin).toBe('jira')
    expect(ev.meta.jira).toMatchObject({ key: 'NAV-7', attachmentId: '10001' })
    expect(changed).toContain('NAV-7')
  })

  it('a failing file emits error and does not abort the batch', async () => {
    const svc = service(fakeClient(() => issue(), new Set(['10001'])))
    await svc.createFromTicket({ slug: 'NAV-7', title: 't', key: 'NAV-7' })
    const results = await svc.ingestAttachments('NAV-7', [
      att('10001', 'bad.txt'),
      att('10002', 'ok.txt')
    ])
    expect(results[0]).toMatchObject({ attachmentId: '10001', status: 'error' })
    expect(results[1]).toMatchObject({ attachmentId: '10002', status: 'done' })
  })

  // extraction is fire-and-forget: flush pending microtasks/timers before asserting
  const settle = (): Promise<void> => new Promise((r) => setTimeout(r, 0))

  it('emits parsing start/stop around extraction', async () => {
    const parsing: Array<{ evidenceId: number; active: boolean }> = []
    const svc = service(
      fakeClient(() => issue()),
      (evidenceId, active) => parsing.push({ evidenceId, active })
    )
    await svc.createFromTicket({ slug: 'NAV-7', title: 't', key: 'NAV-7' })
    await svc.ingestAttachments('NAV-7', [att('10001', 'log.txt')])
    await settle()
    expect(parsing.length).toBe(2)
    expect(parsing[0].active).toBe(true)
    expect(parsing[1].active).toBe(false)
    expect(parsing[0].evidenceId).toBe(parsing[1].evidenceId)
  })

  it('emits parsing stop even when extraction rejects (sync setup failure)', async () => {
    const parsing: Array<{ evidenceId: number; active: boolean }> = []
    const svc = service(
      fakeClient(() => issue()),
      (evidenceId, active) => parsing.push({ evidenceId, active })
    )
    await svc.createFromTicket({ slug: 'NAV-7', title: 't', key: 'NAV-7' })
    // extractDerivedText's fs.mkdirSync(evidence/.derived) sits OUTSIDE its try/catch;
    // planting a file there makes the async fn reject before its internal error handling.
    fs.writeFileSync(path.join(caseDir(argusHome, 'NAV-7'), 'evidence', '.derived'), 'not a dir')
    // .binlog filename → artifactType 'binlog' → extraction actually runs (log.txt short-circuits)
    await svc.ingestAttachments('NAV-7', [att('10004', 'trace.binlog')])
    await settle()
    expect(parsing.length).toBe(2)
    expect(parsing[0].active).toBe(true)
    expect(parsing[1].active).toBe(false)
  })

  it('sanitizes hostile filenames into the evidence dir', async () => {
    const svc = service(fakeClient(() => issue()))
    await svc.createFromTicket({ slug: 'NAV-7', title: 't', key: 'NAV-7' })
    await svc.ingestAttachments('NAV-7', [att('10003', '..\\..\\evil?.txt')])
    const ev = listEvidence(db, 'NAV-7').map((e) => e.relPath)
    expect(ev.some((p) => p.includes('evil_.txt') || p.includes('evil'))).toBe(true)
    expect(ev.every((p) => p.startsWith('evidence/'))).toBe(true)
  })
})

describe('JiraCases.refresh', () => {
  it('updates ticket evidence in place, ingests only new attachments, reports the diff', async () => {
    let current = issue()
    const svc = service(fakeClient(() => current))
    await svc.createFromTicket({ slug: 'NAV-7', title: 't', key: 'NAV-7' })
    await svc.ingestAttachments('NAV-7', current.preview.attachments)
    const before = listEvidence(db, 'NAV-7').length

    current = issue({
      status: 'Resolved',
      attachments: [att('10002', 'new.txt')] // 10001 deleted on Jira, 10002 added
    })
    const summary = await svc.refresh('NAV-7')

    expect(summary.statusChange).toEqual({ from: 'Open', to: 'Resolved' })
    expect(summary.syncedAt).toMatch(/^\d{4}-\d{2}-\d{2}T/) // refresh timestamp for the header
    expect(summary.newAttachments.map((a) => a.id)).toEqual(['10002'])
    expect(summary.deletedOnJira).toEqual([{ attachmentId: '10001', filename: 'log.txt' }])

    const ev = listEvidence(db, 'NAV-7')
    expect(ev.length).toBe(before + 1) // ticket files updated in place; one new attachment
    expect(ev.some((e) => e.relPath === 'evidence/log.txt')).toBe(true) // never removed locally
    const md = ev.find((e) => e.relPath === 'evidence/NAV-7.ticket.md')!
    expect((md.meta.jira as { status: string }).status).toBe('Resolved')
  })

  it('throws not-configured AtlassianError shape when the case has no jira link', async () => {
    const svc = service(fakeClient(() => issue()))
    const { createCase } = await import('../caseService')
    createCase(db, argusHome, { slug: 'BLANK-1', title: 'b' })
    await expect(svc.refresh('BLANK-1')).rejects.toMatchObject({ code: 'not-configured' })
  })
})
