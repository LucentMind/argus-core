import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import type { DatabaseSync } from 'node:sqlite'
import { openDb } from '../db'
import { caseDir } from '../paths'
import { listEvidence } from '../ingest'
import { createDetection } from '../packs/detection'
import { samplePackRegistry, stubExtractors } from '../packs/__tests__/fixtures'
import { JiraCases, type AtlassianClientLike } from '../jiraCases'
import { createCase, getCase, setCaseJiraDeselected } from '../caseService'
import { deriveActionItems } from '../../../shared/triage'
import type {
  JiraAttachmentProgress,
  JiraCommentInfo,
  JiraIssuePreview
} from '../../../shared/jira'
import type { JiraIssueData } from '../atlassian'
import type { EvidenceRecord } from '../../../shared/types'
import { Zip } from 'zip-lib'

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
    priority: null,
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
  failIds: Set<string> = new Set(),
  comments: JiraCommentInfo[] = []
): AtlassianClientLike {
  return {
    getIssue: vi.fn(async () => data()),
    downloadAttachment: vi.fn(async (id: string, dest: string) => {
      if (failIds.has(id)) throw new Error(`download failed: ${id}`)
      fs.writeFileSync(dest, `bytes-of-${id}`)
    }),
    getComments: vi.fn(async () => comments)
  }
}

// Writes a real .zip to `dest` for the given attachment id.
function zipClient(
  data: () => JiraIssueData,
  zipFor: Record<string, Record<string, string>>
): AtlassianClientLike {
  return {
    getIssue: vi.fn(async () => data()),
    getComments: vi.fn(async () => []),
    downloadAttachment: vi.fn(async (id: string, dest: string) => {
      const files = zipFor[id]
      if (!files) {
        fs.writeFileSync(dest, `bytes-of-${id}`)
        return
      }
      const zip = new Zip()
      const srcDir = fs.mkdtempSync(path.join(os.tmpdir(), 'zsrc-'))
      for (const [name, body] of Object.entries(files)) {
        const p = path.join(srcDir, path.basename(name))
        fs.writeFileSync(p, body)
        zip.addFile(p, name)
      }
      await zip.archive(dest)
    })
  }
}

function service(
  client: AtlassianClientLike,
  onParsing?: (evidenceId: number, active: boolean) => void,
  limitsOverride?: Partial<import('../archiveExtract').ArchiveLimits>
): JiraCases {
  return new JiraCases({
    db,
    argusHome,
    detection,
    client,
    site: () => 'https://acme.atlassian.net',
    // resolvable so the mkdirSync-failure test below still reaches the extraction attempt;
    // no test here asserts on successful derived text (see extraction.test.ts for that).
    extractors: stubExtractors('binlog'),
    emitProgress: (p) => progress.push(p),
    evidenceChanged: (slug) => changed.push(slug),
    parsing: (_slug, evidenceId, active) => onParsing?.(evidenceId, active),
    archiveLimits: limitsOverride
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

  // Finding I1: creation fetches the same status/comments/attachments it ingests,
  // but used to leave the sync-state columns empty. markReviewed then baselined
  // off those empty columns, so the very next sync — even with nothing changed
  // upstream — diffed real values against the empty baseline and reported the
  // just-imported ticket, comments, and attachments as brand-new. Reverting the
  // setCaseSyncState call added to createFromTicket must turn this test red.
  it('reports no false action items on the first sync after creation (Finding I1)', async () => {
    const svc = service(
      fakeClient(() => issue(), new Set(), [comment('1', 'first'), comment('2', 'second')])
    )
    await svc.createFromTicket({ slug: 'NAV-7', title: 'Route flickers', key: 'NAV-7' })

    // opening the case captures the review baseline, as the renderer does on open
    svc.markReviewed('NAV-7')

    // first "Sync all" / refresh, upstream completely unchanged
    await svc.refresh('NAV-7')

    const rec = getCase(db, 'NAV-7')!
    expect(deriveActionItems(rec)).toEqual([])
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

  it('rejects an oversized attachment early without downloading it', async () => {
    const client = fakeClient(() => issue())
    const svc = service(client)
    await svc.createFromTicket({ slug: 'NAV-7', title: 't', key: 'NAV-7' })
    const huge = { ...att('10009', 'huge.bin'), size: 600 * 1024 * 1024 } // 600 MB
    const results = await svc.ingestAttachments('NAV-7', [huge])
    expect(results[0]).toMatchObject({ attachmentId: '10009', status: 'error' })
    expect(results[0].error).toContain('exceeds the 500 MB limit')
    expect(client.downloadAttachment).not.toHaveBeenCalled()
  })

  it('rejects the oversized file but still ingests a normal one in the same batch', async () => {
    const client = fakeClient(() => issue())
    const svc = service(client)
    await svc.createFromTicket({ slug: 'NAV-7', title: 't', key: 'NAV-7' })
    const huge = { ...att('10009', 'huge.bin'), size: 600 * 1024 * 1024 }
    const results = await svc.ingestAttachments('NAV-7', [huge, att('10001', 'ok.txt')])
    expect(results[0]).toMatchObject({ attachmentId: '10009', status: 'error' })
    expect(results[1]).toMatchObject({ attachmentId: '10001', status: 'done' })
    expect(client.downloadAttachment).toHaveBeenCalledTimes(1)
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

describe('zip attachment extraction', () => {
  it('ingests inner files as evidence with extractedFrom meta and keeps the archive', async () => {
    const preview: Partial<JiraIssuePreview> = {
      attachments: [
        {
          id: '20001',
          filename: 'bundle.zip',
          size: 9,
          mimeType: 'application/zip',
          createdAt: 'c'
        }
      ]
    }
    const client = zipClient(() => issue(preview), {
      '20001': { 'logs/app.log': 'hello', 'notes.txt': 'world' }
    })
    const svc = service(client)
    createCase(db, argusHome, { slug: 'nav-7', title: 'T', jiraKey: 'NAV-7' })
    const results = await svc.ingestAttachments('nav-7', issue(preview).preview.attachments)
    // archive attachment reports done with an extracted count
    expect(results[0]).toMatchObject({ attachmentId: '20001', status: 'done', extractedCount: 2 })
    const ev = listEvidence(db, 'nav-7')
    // 1 archive + 2 inner files
    const archive = ev.find(
      (e) => (e.meta.jira as { attachmentId?: string })?.attachmentId === '20001'
    )
    expect(archive?.artifactType).toBe('archive')
    const inner = ev.filter((e) => e.meta.extractedFrom)
    expect(inner).toHaveLength(2)
    // inner files carry extractedFrom, NOT meta.jira.attachmentId
    for (const e of inner) {
      expect((e.meta.extractedFrom as { attachmentId: string }).attachmentId).toBe('20001')
      expect((e.meta.jira as { attachmentId?: string })?.attachmentId).toBeUndefined()
    }
  })

  it('a subsequent refresh still diffs the archive correctly (inner files do not pollute the diff)', async () => {
    const preview: Partial<JiraIssuePreview> = {
      attachments: [
        {
          id: '20001',
          filename: 'bundle.zip',
          size: 9,
          mimeType: 'application/zip',
          createdAt: 'c'
        }
      ]
    }
    const client = zipClient(() => issue(preview), { '20001': { 'a.txt': 'a', 'b.txt': 'b' } })
    const svc = service(client)
    createCase(db, argusHome, { slug: 'nav-7', title: 'T', jiraKey: 'NAV-7' })
    await svc.ingestAttachments('nav-7', issue(preview).preview.attachments)
    const summary = await svc.refresh('nav-7')
    expect(summary.ingestedAttachments.map((a) => a.id)).toEqual(['20001'])
    expect(summary.newAttachments).toEqual([])
    expect(summary.deletedOnJira).toEqual([])
  })

  it('on a cap breach: archive is kept, zero inner files, extractError surfaced', async () => {
    const preview: Partial<JiraIssuePreview> = {
      attachments: [
        {
          id: '20002',
          filename: 'toomany.zip',
          size: 9,
          mimeType: 'application/zip',
          createdAt: 'c'
        }
      ]
    }
    // Force a breach via a tiny override injected through the service (see Step 4 note).
    const client = zipClient(() => issue(preview), {
      '20002': { 'a.txt': 'a', 'b.txt': 'b', 'c.txt': 'c' }
    })
    const svc = service(client, undefined, { maxEntries: 2 }) // limits override
    createCase(db, argusHome, { slug: 'nav-7', title: 'T', jiraKey: 'NAV-7' })
    const results = await svc.ingestAttachments('nav-7', issue(preview).preview.attachments)
    expect(results[0]).toMatchObject({ attachmentId: '20002', status: 'done' })
    expect(results[0].extractError).toBeTruthy()
    const ev = listEvidence(db, 'nav-7')
    expect(ev.filter((e) => e.meta.extractedFrom)).toHaveLength(0)
    expect(ev.some((e) => e.artifactType === 'archive')).toBe(true)
  })
})

describe('JiraCases.refresh', () => {
  it('updates ticket evidence in place; reports the attachment diff without downloading', async () => {
    let current = issue()
    const svc = service(fakeClient(() => current))
    await svc.createFromTicket({ slug: 'NAV-7', title: 't', key: 'NAV-7' })
    await svc.ingestAttachments('NAV-7', current.preview.attachments)
    const before = listEvidence(db, 'NAV-7').length

    current = issue({
      status: 'Resolved',
      attachments: [att('10002', 'new.txt')] // 10001 deleted on Jira, 10002 added
    })
    const grown = fakeClient(() => current)
    const summary = await service(grown).refresh('NAV-7')

    expect(summary.statusChange).toEqual({ from: 'Open', to: 'Resolved' })
    expect(summary.syncedAt).toMatch(/^\d{4}-\d{2}-\d{2}T/) // refresh timestamp for the header
    // refresh never downloads: 10002 is only reported, not ingested
    expect(summary.newAttachments.map((a) => a.id)).toEqual(['10002'])
    expect(summary.deletedOnJira).toEqual([{ attachmentId: '10001', filename: 'log.txt' }])
    expect(grown.downloadAttachment).not.toHaveBeenCalled()

    const ev = listEvidence(db, 'NAV-7')
    expect(ev.length).toBe(before) // ticket files updated in place; no attachment ingested
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

const jiraMetaOf = (e: EvidenceRecord): { attachmentId?: string } =>
  (e.meta.jira ?? {}) as { attachmentId?: string }

describe('JiraCases.refresh attachment classification (no auto-ingest)', () => {
  it('never downloads on refresh; new attachments are reported as pending', async () => {
    const client = fakeClient(() => issue({ attachments: [] }))
    const svc = service(client)
    await svc.createFromTicket({ slug: 'NAV-7', title: 'T', key: 'NAV-7' })
    // ticket grew an attachment since creation
    const grown = fakeClient(() => issue({ attachments: [att('10001', 'log.txt')] }))
    const summary = await service(grown).refresh('NAV-7')
    expect(summary.newAttachments.map((a) => a.id)).toEqual(['10001'])
    expect(grown.downloadAttachment).not.toHaveBeenCalled()
    expect(listEvidence(db, 'NAV-7').some((e) => jiraMetaOf(e).attachmentId)).toBe(false)
  })

  it('deselected ids are excluded from newAttachments and listed separately', async () => {
    const client = fakeClient(() =>
      issue({ attachments: [att('10001', 'a.txt'), att('10002', 'b.txt')] })
    )
    const svc = service(client)
    await svc.createFromTicket({ slug: 'NAV-7', title: 'T', key: 'NAV-7' })
    setCaseJiraDeselected(db, argusHome, 'NAV-7', ['10001'])
    const summary = await svc.refresh('NAV-7')
    expect(summary.newAttachments.map((a) => a.id)).toEqual(['10002'])
    expect(summary.deselectedAttachments.map((a) => a.id)).toEqual(['10001'])
  })

  it('lists already-ingested live attachments as ingestedAttachments (synced in the dialog)', async () => {
    const client = fakeClient(() =>
      issue({ attachments: [att('10001', 'log.txt'), att('10002', 'new.txt')] })
    )
    const svc = service(client)
    await svc.createFromTicket({ slug: 'NAV-7', title: 'T', key: 'NAV-7' })
    await svc.ingestAttachments('NAV-7', [att('10001', 'log.txt')])
    const summary = await svc.refresh('NAV-7')
    expect(summary.ingestedAttachments.map((a) => a.id)).toEqual(['10001'])
    expect(summary.newAttachments.map((a) => a.id)).toEqual(['10002'])
  })

  it('still reports deletions on Jira for ingested attachments', async () => {
    const client = fakeClient(() => issue({ attachments: [att('10001', 'log.txt')] }))
    const svc = service(client)
    await svc.createFromTicket({ slug: 'NAV-7', title: 'T', key: 'NAV-7' })
    await svc.ingestAttachments('NAV-7', [att('10001', 'log.txt')])
    const gone = service(fakeClient(() => issue({ attachments: [] })))
    const summary = await gone.refresh('NAV-7')
    expect(summary.deletedOnJira).toEqual([{ attachmentId: '10001', filename: 'log.txt' }])
  })
})

const comment = (id: string, body: string): JiraCommentInfo => ({
  id,
  author: 'Ada',
  created: '2026-07-01T00:00:00Z',
  updated: '2026-07-01T00:00:00Z',
  bodyMarkdown: body
})

const mkComment = (id: string): JiraCommentInfo => comment(id, `comment body ${id}`)

/**
 * Builds a JiraCases service backed by a fake client, and links case 'C-1'
 * to a Jira key up front (sync, via caseService directly) so refresh('C-1')
 * has something to refresh against without needing an awaited createFromTicket.
 */
function setup(
  opts: {
    preview?: Partial<JiraIssuePreview>
    comments?: JiraCommentInfo[]
    commentsThrow?: Error
  } = {}
): { svc: JiraCases; db: DatabaseSync; home: string; client: AtlassianClientLike } {
  const client = fakeClient(() => issue(opts.preview ?? {}))
  if (opts.commentsThrow) {
    const err = opts.commentsThrow
    client.getComments = vi.fn(async () => {
      throw err
    })
  } else if (opts.comments) {
    const comments = opts.comments
    client.getComments = vi.fn(async () => comments)
  }
  createCase(db, argusHome, {
    slug: 'C-1',
    title: 'Case C-1',
    jiraKey: opts.preview?.key ?? 'C-1'
  })
  return { svc: service(client), db, home: argusHome, client }
}

describe('JiraCases comments file', () => {
  it('creates <KEY>.comments.md with provenance banner and attributed comments', async () => {
    const svc = service(fakeClient(() => issue(), new Set(), [comment('1', 'saw it in prod logs')]))
    await svc.createFromTicket({ slug: 'NAV-7', title: 'T', key: 'NAV-7' })
    const ev = listEvidence(db, 'NAV-7')
    const cm = ev.find((e) => e.relPath === 'evidence/NAV-7.comments.md')!
    expect((cm.meta.jira as { role: string; commentCount: number }).role).toBe('comments')
    expect((cm.meta.jira as { commentCount: number }).commentCount).toBe(1)
    const body = fs.readFileSync(
      path.join(caseDir(argusHome, 'NAV-7'), 'evidence', 'NAV-7.comments.md'),
      'utf8'
    )
    expect(body).toContain('Provenance notice')
    expect(body).toContain('unverified')
    expect(body).toContain('## Ada — 2026-07-01T00:00:00Z')
    expect(body).toContain('saw it in prod logs')
  })

  it('writes the file even with zero comments', async () => {
    const svc = service(fakeClient(() => issue()))
    await svc.createFromTicket({ slug: 'NAV-7', title: 'T', key: 'NAV-7' })
    const body = fs.readFileSync(
      path.join(caseDir(argusHome, 'NAV-7'), 'evidence', 'NAV-7.comments.md'),
      'utf8'
    )
    expect(body).toContain('_(no comments)_')
  })

  it('refresh updates the file in place and reports newComments delta', async () => {
    let comments = [comment('1', 'one')]
    const client = fakeClient(() => issue(), new Set(), [])
    client.getComments = vi.fn(async () => comments)
    const svc = service(client)
    await svc.createFromTicket({ slug: 'NAV-7', title: 'T', key: 'NAV-7' })
    comments = [comment('1', 'one'), comment('2', 'two'), comment('3', 'three')]
    const summary = await svc.refresh('NAV-7')
    expect(summary.newComments).toBe(2)
    const ev = listEvidence(db, 'NAV-7')
    expect(ev.filter((e) => e.relPath.includes('.comments.md'))).toHaveLength(1)
  })

  it('refresh degrades when the comments fetch fails: rest of refresh proceeds', async () => {
    const client = fakeClient(() => issue())
    const svc0 = service(client)
    await svc0.createFromTicket({ slug: 'NAV-7', title: 'T', key: 'NAV-7' })
    client.getComments = vi.fn(async () => {
      throw new Error('comments boom')
    })
    const summary = await service(client).refresh('NAV-7')
    expect(summary.commentsError).toContain('comments boom')
    expect(summary.newComments).toBe(0)
    expect(summary.key).toBe('NAV-7')
  })
})

describe('refresh persists sync state', () => {
  it('writes status, priority, comment count and attachment ids onto the case', async () => {
    const { svc, db, home } = setup({
      preview: {
        key: 'PROJ-1',
        summary: 'S',
        status: 'In Progress',
        priority: 'High',
        labels: [],
        reporter: null,
        created: '2026-07-01T00:00:00.000Z',
        updated: '2026-07-20T00:00:00.000Z',
        attachments: [
          { id: 'a1', filename: 'f.log', size: 1, mimeType: 'text/plain', createdAt: '' }
        ]
      },
      comments: [mkComment('c1'), mkComment('c2')]
    })
    await svc.refresh('C-1')
    const rec = getCase(db, 'C-1')!
    expect(rec.jiraStatus).toBe('In Progress')
    expect(rec.jiraPriority).toBe('High')
    expect(rec.jiraCommentCount).toBe(2)
    expect(rec.jiraAttachmentIds).toEqual(['a1'])
    expect(rec.lastSyncError).toBeNull()
    expect(home).toBe(argusHome)
  })

  it('leaves a previously-synced comment count untouched when a later comments fetch fails', async () => {
    const { svc, db, client } = setup({ comments: [mkComment('c1'), mkComment('c2')] })
    // first refresh succeeds: establishes a real, non-null count to protect
    await svc.refresh('C-1')
    expect(getCase(db, 'C-1')!.jiraCommentCount).toBe(2)

    // comments fetch now fails on a subsequent refresh
    client.getComments = vi.fn(async () => {
      throw new Error('boom')
    })
    await svc.refresh('C-1')
    // the known-good count must survive the partial refresh, not be clobbered with null
    expect(getCase(db, 'C-1')!.jiraCommentCount).toBe(2)
  })
})

const PREVIEW = {
  key: 'PROJ-1',
  summary: 'S',
  status: 'In Progress',
  priority: 'High',
  labels: [],
  reporter: null,
  created: '2026-07-01T00:00:00.000Z',
  updated: '2026-07-20T00:00:00.000Z',
  attachments: [{ id: 'a1', filename: 'f.log', size: 1, mimeType: 'text/plain', createdAt: '' }]
}

describe('markReviewed', () => {
  it('captures the current upstream state as the baseline, clearing action items', async () => {
    const { svc } = setup({ preview: PREVIEW, comments: [mkComment('c1'), mkComment('c2')] })
    await svc.refresh('C-1')
    const rec = svc.markReviewed('C-1')
    expect(rec.reviewBaseline).toMatchObject({
      status: 'In Progress',
      commentCount: 2,
      attachmentIds: ['a1']
    })
    expect(deriveActionItems(rec)).toEqual([])
  })

  it('is idempotent — a second sync with no upstream change yields no items', async () => {
    const { svc, db } = setup({ preview: PREVIEW, comments: [mkComment('c1'), mkComment('c2')] })
    await svc.refresh('C-1')
    svc.markReviewed('C-1')
    await svc.refresh('C-1')
    await svc.refresh('C-1')
    expect(deriveActionItems(getCase(db, 'C-1')!)).toEqual([])
    expect(getCase(db, 'C-1')!.reviewBaseline).toMatchObject({
      status: 'In Progress',
      commentCount: 2,
      attachmentIds: ['a1']
    })
  })

  it('captures a zero baseline for a case that has never synced', () => {
    const { svc } = setup()
    const rec = svc.markReviewed('C-1')
    expect(rec.reviewBaseline).toMatchObject({ status: '', commentCount: 0, attachmentIds: [] })
  })
})
