import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import type { DatabaseSync } from 'node:sqlite'
import { openDb } from '../db'
import { caseDir } from '../paths'
import { ingestContent, listEvidence } from '../ingest'
import { createDetection } from '../packs/detection'
import { samplePackRegistry, stubExtractors } from '../packs/__tests__/fixtures'
import { createImmediateQueue, type IngestJob } from '../ingestQueue'
import { readIndexState } from '../indexState'
import { extractDerivedText } from '../extraction'
import { JiraCases, type AtlassianClientLike } from '../jiraCases'
import {
  createCase,
  getCase,
  listCaseJiraLinks,
  setCaseJiraDeselected,
  setCaseJiraLinkDeselected
} from '../caseService'
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
/** Extraction promises the fake queue kicked off, so `settle()` can wait for them. */
let extractions: Array<Promise<unknown>>
// extraction is fire-and-forget: drain what the queue kicked off, then flush timers
const settle = async (): Promise<void> => {
  await Promise.allSettled(extractions)
  await new Promise((r) => setTimeout(r, 0))
}
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
    cloneLinks: [],
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
  onEnqueue?: (job: IngestJob) => void,
  limitsOverride?: Partial<import('../archiveExtract').ArchiveLimits>
): JiraCases {
  // Stands in for the real IngestQueue: indexes inline when the job says to (so the FTS
  // assertions below hold), then runs extraction for EVERY job — indexable or not.
  // JiraCases' contract is now "enqueue it", not "index and extract it".
  const immediate = createImmediateQueue(db, argusHome)
  const extractors = stubExtractors('binlog')
  return new JiraCases({
    db,
    argusHome,
    detection,
    client,
    site: () => 'https://acme.atlassian.net',
    queue: {
      enqueue: (job) => {
        immediate.enqueue(job)
        onEnqueue?.(job)
        const rec = listEvidence(db, job.caseSlug, 'all').find((e) => e.id === job.evidenceId)
        if (rec) extractions.push(extractDerivedText(db, argusHome, immediate, rec, extractors))
      },
      abort: (id) => immediate.abort(id)
    },
    emitProgress: (p) => progress.push(p),
    evidenceChanged: (slug) => changed.push(slug),
    archiveLimits: limitsOverride
  })
}

beforeEach(() => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'argus-jira-'))
  argusHome = path.join(tmp, 'home')
  db = openDb(path.join(argusHome, 'argus.db'))
  progress = []
  changed = []
  extractions = []
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
  // Phase-model review: createFromTicket ingests the ticket md/json/comments as evidence
  // with origin 'jira' as a side effect of syncing. Because evidence used to be a phase
  // signal regardless of origin, a case created from a ticket read "Analyzing" before any
  // human touched it — background sync moving the phase is exactly what the design forbids.
  it('leaves a freshly-created case open — Jira-origin evidence is not a phase signal', async () => {
    const svc = service(fakeClient(() => issue()))
    await svc.createFromTicket({ slug: 'NAV-7', title: 'Route flickers', key: 'NAV-7' })
    expect(getCase(db, 'NAV-7')!.phase).toBe('open')
  })

  it('moves to analyzing once real investigation work lands on a Jira-created case', async () => {
    const svc = service(fakeClient(() => issue()))
    await svc.createFromTicket({ slug: 'NAV-7', title: 'Route flickers', key: 'NAV-7' })
    // a human-uploaded (non-Jira-origin) evidence row is the work signal.
    const { ingestBytes } = await import('../ingest')
    ingestBytes(
      db,
      argusHome,
      detection,
      createImmediateQueue(db, argusHome),
      'NAV-7',
      'notes.txt',
      Buffer.from('seen in prod'),
      'upload'
    )
    expect(getCase(db, 'NAV-7')!.phase).toBe('analyzing')
  })

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
    const results = await svc.ingestAttachments('NAV-7', 'NAV-7', [att('10001', 'log.txt')])
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
    const results = await svc.ingestAttachments('NAV-7', 'NAV-7', [
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
    const results = await svc.ingestAttachments('NAV-7', 'NAV-7', [huge])
    expect(results[0]).toMatchObject({ attachmentId: '10009', status: 'error' })
    expect(results[0].error).toContain('exceeds the 500 MB limit')
    expect(client.downloadAttachment).not.toHaveBeenCalled()
  })

  it('rejects the oversized file but still ingests a normal one in the same batch', async () => {
    const client = fakeClient(() => issue())
    const svc = service(client)
    await svc.createFromTicket({ slug: 'NAV-7', title: 't', key: 'NAV-7' })
    const huge = { ...att('10009', 'huge.bin'), size: 600 * 1024 * 1024 }
    const results = await svc.ingestAttachments('NAV-7', 'NAV-7', [huge, att('10001', 'ok.txt')])
    expect(results[0]).toMatchObject({ attachmentId: '10009', status: 'error' })
    expect(results[1]).toMatchObject({ attachmentId: '10001', status: 'done' })
    expect(client.downloadAttachment).toHaveBeenCalledTimes(1)
  })

  // Indexing + extraction (and the progress they report) moved behind IngestQueue; what
  // JiraCases still owns is handing every downloaded attachment to that queue.
  it('enqueues the downloaded attachment for background indexing', async () => {
    const jobs: IngestJob[] = []
    const svc = service(
      fakeClient(() => issue()),
      (job) => jobs.push(job)
    )
    await svc.createFromTicket({ slug: 'NAV-7', title: 't', key: 'NAV-7' })
    const before = jobs.length
    const [done] = await svc.ingestAttachments('NAV-7', 'NAV-7', [att('10001', 'log.txt')])
    await settle()
    const forAttachment = jobs.slice(before)
    expect(forAttachment).toHaveLength(1)
    expect(forAttachment[0]).toMatchObject({ caseSlug: 'NAV-7', evidenceId: done.evidenceId })
    expect(fs.existsSync(forAttachment[0].absPath)).toBe(true)
  })

  // A non-indexable attachment must STILL be enqueued: extraction is what a binary
  // artifact is enqueued for. Gating the enqueue on indexability kills derived text for
  // exactly the files pack extractors exist to handle.
  it('enqueues a non-indexable attachment so it still gets extracted', async () => {
    const jobs: IngestJob[] = []
    const svc = service(
      fakeClient(() => issue()),
      (job) => jobs.push(job)
    )
    await svc.createFromTicket({ slug: 'NAV-7', title: 't', key: 'NAV-7' })
    const before = jobs.length
    const [done] = await svc.ingestAttachments('NAV-7', 'NAV-7', [att('10004', 'trace.binlog')])
    await settle()

    expect(done.status).toBe('done')
    const rec = listEvidence(db, 'NAV-7', 'all').find((e) => e.id === done.evidenceId)!
    expect(readIndexState(rec.meta)).toBe('skipped') // nothing to index...

    const forAttachment = jobs.slice(before)
    expect(forAttachment).toHaveLength(1) // ...but it was handed to the queue anyway
    expect(forAttachment[0]).toMatchObject({ evidenceId: done.evidenceId, index: false })

    // and phase 2 actually ran: a derived-text row exists for it
    const derived = listEvidence(db, 'NAV-7', 'all').filter(
      (e) => e.meta.derivedFrom === done.evidenceId
    )
    expect(derived).toHaveLength(1)
  })

  it('sanitizes hostile filenames into the evidence dir', async () => {
    const svc = service(fakeClient(() => issue()))
    await svc.createFromTicket({ slug: 'NAV-7', title: 't', key: 'NAV-7' })
    await svc.ingestAttachments('NAV-7', 'NAV-7', [att('10003', '..\\..\\evil?.txt')])
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
    const results = await svc.ingestAttachments(
      'nav-7',
      'NAV-7',
      issue(preview).preview.attachments
    )
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
    await svc.ingestAttachments('nav-7', 'NAV-7', issue(preview).preview.attachments)
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
    const results = await svc.ingestAttachments(
      'nav-7',
      'NAV-7',
      issue(preview).preview.attachments
    )
    expect(results[0]).toMatchObject({ attachmentId: '20002', status: 'done' })
    expect(results[0].extractError).toBeTruthy()
    const ev = listEvidence(db, 'nav-7')
    expect(ev.filter((e) => e.meta.extractedFrom)).toHaveLength(0)
    expect(ev.some((e) => e.artifactType === 'archive')).toBe(true)
  })

  it('does NOT explode a zip-structured file that is not named .zip (e.g. a .docx)', async () => {
    // report.docx is a real zip (Office docs are ZIP containers) so it detects
    // as artifactType 'archive' by magic bytes, but the extension gate must
    // exclude it — only genuine .zip-named files get exploded.
    const preview: Partial<JiraIssuePreview> = {
      attachments: [
        {
          id: '20003',
          filename: 'report.docx',
          size: 9,
          mimeType: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
          createdAt: 'c'
        }
      ]
    }
    const client = zipClient(() => issue(preview), {
      '20003': { 'word/document.xml': '<doc/>' }
    })
    const svc = service(client)
    createCase(db, argusHome, { slug: 'nav-7', title: 'T', jiraKey: 'NAV-7' })
    const results = await svc.ingestAttachments(
      'nav-7',
      'NAV-7',
      issue(preview).preview.attachments
    )
    expect(results[0]).toMatchObject({ attachmentId: '20003', status: 'done' })
    expect(results[0].extractedCount).toBeUndefined()
    const ev = listEvidence(db, 'nav-7')
    expect(ev.filter((e) => e.meta.extractedFrom)).toHaveLength(0)
    expect(ev).toHaveLength(1)
  })

  it('does NOT explode a .bintrace.zip already claimed by the bintrace pack detector', async () => {
    // The sample pack registry's bintrace detector claims .bintrace.zip before
    // the generic archive detector gets a chance, so artifactType is 'bintrace'
    // (not 'archive') — the artifactType gate must exclude it, since bintrace
    // has its own extractor and must not be double-processed as a zip archive.
    const preview: Partial<JiraIssuePreview> = {
      attachments: [
        {
          id: '20004',
          filename: 'bundle.bintrace.zip',
          size: 9,
          mimeType: 'application/zip',
          createdAt: 'c'
        }
      ]
    }
    const client = zipClient(() => issue(preview), {
      '20004': { 'trace.bin': 'binarydata' }
    })
    const svc = service(client)
    createCase(db, argusHome, { slug: 'nav-7', title: 'T', jiraKey: 'NAV-7' })
    const results = await svc.ingestAttachments(
      'nav-7',
      'NAV-7',
      issue(preview).preview.attachments
    )
    expect(results[0]).toMatchObject({ attachmentId: '20004', status: 'done' })
    expect(results[0].extractedCount).toBeUndefined()
    const ev = listEvidence(db, 'nav-7')
    expect(ev.filter((e) => e.meta.extractedFrom)).toHaveLength(0)
    const archive = ev.find(
      (e) => (e.meta.jira as { attachmentId?: string })?.attachmentId === '20004'
    )
    expect(archive?.artifactType).toBe('bintrace')
  })
})

describe('JiraCases.refresh', () => {
  it('updates ticket evidence in place; reports the attachment diff without downloading', async () => {
    let current = issue()
    const svc = service(fakeClient(() => current))
    await svc.createFromTicket({ slug: 'NAV-7', title: 't', key: 'NAV-7' })
    await svc.ingestAttachments('NAV-7', 'NAV-7', current.preview.attachments)
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
    await svc.ingestAttachments('NAV-7', 'NAV-7', [att('10001', 'log.txt')])
    const summary = await svc.refresh('NAV-7')
    expect(summary.ingestedAttachments.map((a) => a.id)).toEqual(['10001'])
    expect(summary.newAttachments.map((a) => a.id)).toEqual(['10002'])
  })

  it('still reports deletions on Jira for ingested attachments', async () => {
    const client = fakeClient(() => issue({ attachments: [att('10001', 'log.txt')] }))
    const svc = service(client)
    await svc.createFromTicket({ slug: 'NAV-7', title: 'T', key: 'NAV-7' })
    await svc.ingestAttachments('NAV-7', 'NAV-7', [att('10001', 'log.txt')])
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
  attachments: [{ id: 'a1', filename: 'f.log', size: 1, mimeType: 'text/plain', createdAt: '' }],
  cloneLinks: []
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

describe('JiraCases source tickets', () => {
  it('stamps the passed key on attachment evidence, not the case key', async () => {
    const svc = service(fakeClient(() => issue()))
    await svc.createFromTicket({ slug: 'NAV-7', title: 'T', key: 'NAV-7' })
    await svc.ingestAttachments('NAV-7', 'CUST-9', [att('20001', 'customer.log')])
    await settle()

    const rec = listEvidence(db, 'NAV-7').find((e) => e.relPath.includes('customer.log'))!
    expect((rec.meta.jira as { key: string }).key).toBe('CUST-9')
  })

  it("does not adopt another ticket's evidence as its own", async () => {
    const svc = service(fakeClient(() => issue()))
    await svc.createFromTicket({ slug: 'NAV-7', title: 'T', key: 'NAV-7' })
    await settle()

    // Simulate evidence contributed by a different ticket carrying the same role.
    ingestContent(
      db,
      argusHome,
      detection,
      createImmediateQueue(db, argusHome),
      'NAV-7',
      'CUST-9.ticket.md',
      '# CUST-9: original\n',
      'jira',
      { jira: { key: 'CUST-9', role: 'ticket', status: 'Open', syncedAt: 'x' } }
    )
    await settle()

    await svc.refresh('NAV-7')
    await settle()

    const foreign = listEvidence(db, 'NAV-7').find((e) => e.relPath.includes('CUST-9.ticket.md'))!
    expect(
      fs.readFileSync(path.join(caseDir(argusHome, 'NAV-7'), foreign.relPath), 'utf8')
    ).toContain('CUST-9: original')
    expect((foreign.meta.jira as { key: string }).key).toBe('CUST-9')
  })

  it('imports a source ticket as attributed evidence without touching the primary', async () => {
    const byKey: Record<string, JiraIssueData> = {
      'NAV-7': issue(),
      'CUST-9': issue({ key: 'CUST-9', summary: 'Customer report', attachments: [] })
    }
    const client: AtlassianClientLike = {
      getIssue: vi.fn(async (k: string) => byKey[k]),
      downloadAttachment: vi.fn(async () => {}),
      getComments: vi.fn(async (k: string) =>
        k === 'CUST-9'
          ? [
              {
                id: 'c1',
                author: 'Cust',
                created: 'c',
                updated: 'c',
                bodyMarkdown: 'happens daily'
              }
            ]
          : []
      )
    }
    const svc = service(client)
    await svc.createFromTicket({ slug: 'NAV-7', title: 'T', key: 'NAV-7' })
    await svc.importSourceTicket('NAV-7', 'CUST-9')
    await settle()

    expect(listCaseJiraLinks(db, 'NAV-7').map((l) => l.key)).toEqual(['CUST-9'])

    const ev = listEvidence(db, 'NAV-7')
    const roles = (relPath: string): { role: string; key: string } =>
      ev.find((e) => e.relPath === `evidence/${relPath}`)!.meta.jira as {
        role: string
        key: string
      }
    expect(roles('CUST-9.ticket.md')).toMatchObject({ role: 'source-ticket', key: 'CUST-9' })
    expect(roles('CUST-9.ticket.json')).toMatchObject({ role: 'source-ticket-raw', key: 'CUST-9' })
    expect(roles('CUST-9.comments.md')).toMatchObject({ role: 'source-comments', key: 'CUST-9' })

    // The primary's own evidence is untouched and still primary-attributed.
    expect(roles('NAV-7.ticket.md')).toMatchObject({ role: 'ticket', key: 'NAV-7' })

    // The case is still bound to the clone — a source never becomes the case's ticket.
    expect(getCase(db, 'NAV-7')!.jiraKey).toBe('NAV-7')
  })

  it('re-importing a source updates its evidence in place rather than duplicating', async () => {
    const byKey: Record<string, JiraIssueData> = {
      'NAV-7': issue(),
      'CUST-9': issue({ key: 'CUST-9', summary: 'v1', attachments: [] })
    }
    const client: AtlassianClientLike = {
      getIssue: vi.fn(async (k: string) => byKey[k]),
      downloadAttachment: vi.fn(async () => {}),
      getComments: vi.fn(async () => [])
    }
    const svc = service(client)
    await svc.createFromTicket({ slug: 'NAV-7', title: 'T', key: 'NAV-7' })
    await svc.importSourceTicket('NAV-7', 'CUST-9')
    await settle()
    byKey['CUST-9'] = issue({ key: 'CUST-9', summary: 'v2', attachments: [] })
    await svc.importSourceTicket('NAV-7', 'CUST-9')
    await settle()

    const ev = listEvidence(db, 'NAV-7').filter((e) => e.relPath === 'evidence/CUST-9.ticket.md')
    expect(ev).toHaveLength(1)
    expect(
      fs.readFileSync(
        path.join(caseDir(argusHome, 'NAV-7'), 'evidence', 'CUST-9.ticket.md'),
        'utf8'
      )
    ).toContain('v2')
    expect(listCaseJiraLinks(db, 'NAV-7')).toHaveLength(1)
  })

  it('reports new source attachments without downloading them, and contains a source failure', async () => {
    let custThrows = false
    const cust = (atts: JiraIssuePreview['attachments']): JiraIssueData =>
      issue({ key: 'CUST-9', summary: 'Customer report', attachments: atts })
    let custAtts = [att('20001', 'first.log')]
    const client: AtlassianClientLike = {
      getIssue: vi.fn(async (k: string) => {
        if (k === 'CUST-9') {
          if (custThrows) throw new Error('403 no access')
          return cust(custAtts)
        }
        return issue()
      }),
      downloadAttachment: vi.fn(async (id: string, dest: string) => {
        fs.writeFileSync(dest, `bytes-of-${id}`)
      }),
      getComments: vi.fn(async () => [])
    }
    const svc = service(client)
    await svc.createFromTicket({ slug: 'NAV-7', title: 'T', key: 'NAV-7' })
    await svc.importSourceTicket('NAV-7', 'CUST-9')
    await settle()

    // First refresh sees CUST-9's existing attachment as new and reports it.
    const r1 = await svc.refresh('NAV-7')
    await settle()
    expect(r1.sources).toHaveLength(1)
    expect(r1.sources[0].key).toBe('CUST-9')
    expect(r1.sources[0].newAttachments.map((a) => a.id)).toEqual(['20001'])
    // Reported, NOT downloaded.
    expect(client.downloadAttachment).not.toHaveBeenCalled()

    // Second refresh: the attachment has NOT been ingested (or declined) by the user,
    // so it must keep being reported — refresh's baseline-advance must not silently
    // suppress it. This is the crux of Fix 3: an un-acted-on attachment reappears
    // on every refresh until the user actually ingests (or declines) it.
    const r2 = await svc.refresh('NAV-7')
    await settle()
    expect(r2.sources[0].newAttachments.map((a) => a.id)).toEqual(['20001'])

    // Once the attachment IS ingested, it stops being reported as new.
    await svc.ingestAttachments('NAV-7', 'CUST-9', [att('20001', 'first.log')])
    await settle()
    const r2b = await svc.refresh('NAV-7')
    await settle()
    expect(r2b.sources[0].newAttachments).toEqual([])

    // A third one appears upstream.
    custAtts = [att('20001', 'first.log'), att('20002', 'second.log')]
    const r3 = await svc.refresh('NAV-7')
    await settle()
    expect(r3.sources[0].newAttachments.map((a) => a.id)).toEqual(['20002'])

    // The source goes unreadable: the primary's refresh still succeeds.
    custThrows = true
    const r4 = await svc.refresh('NAV-7')
    await settle()
    expect(r4.key).toBe('NAV-7')
    expect(r4.sources[0]).toMatchObject({ key: 'CUST-9', error: '403 no access' })
    expect(getCase(db, 'NAV-7')!.lastSyncError).toBeNull()
  })

  it("keeps both tickets' evidence across a refresh", async () => {
    const client: AtlassianClientLike = {
      getIssue: vi.fn(async (k: string) =>
        k === 'CUST-9' ? issue({ key: 'CUST-9', summary: 'Customer', attachments: [] }) : issue()
      ),
      downloadAttachment: vi.fn(async () => {}),
      getComments: vi.fn(async () => [])
    }
    const svc = service(client)
    await svc.createFromTicket({ slug: 'NAV-7', title: 'T', key: 'NAV-7' })
    await svc.importSourceTicket('NAV-7', 'CUST-9')
    await settle()
    await svc.refresh('NAV-7')
    await settle()

    const paths = listEvidence(db, 'NAV-7').map((e) => e.relPath)
    expect(paths).toContain('evidence/NAV-7.ticket.md')
    expect(paths).toContain('evidence/CUST-9.ticket.md')
  })

  it('reports only newly added comments on a source ticket, not the running total', async () => {
    let custComments = [comment('c1', 'first'), comment('c2', 'second')]
    const client: AtlassianClientLike = {
      getIssue: vi.fn(async (k: string) =>
        k === 'CUST-9'
          ? issue({ key: 'CUST-9', summary: 'Customer report', attachments: [] })
          : issue()
      ),
      downloadAttachment: vi.fn(async () => {}),
      getComments: vi.fn(async (k: string) => (k === 'CUST-9' ? custComments : []))
    }
    const svc = service(client)
    await svc.createFromTicket({ slug: 'NAV-7', title: 'T', key: 'NAV-7' })
    await svc.importSourceTicket('NAV-7', 'CUST-9')
    await settle()

    // Refresh once: establishes the baseline (source has 2 comments upstream, unchanged
    // since import, so this refresh itself reports zero new comments).
    const r1 = await svc.refresh('NAV-7')
    await settle()
    expect(r1.sources[0].newComments).toBe(0)

    // The source gains comments upstream, independent of the case's own ticket.
    custComments = [
      ...custComments,
      comment('c3', 'third'),
      comment('c4', 'fourth'),
      comment('c5', 'fifth')
    ]

    const r2 = await svc.refresh('NAV-7')
    await settle()
    expect(r2.sources[0].newComments).toBe(3)
  })

  it('reports a source comments-fetch failure via commentsError, not silently', async () => {
    const client: AtlassianClientLike = {
      getIssue: vi.fn(async (k: string) =>
        k === 'CUST-9' ? issue({ key: 'CUST-9', summary: 'Customer', attachments: [] }) : issue()
      ),
      downloadAttachment: vi.fn(async () => {}),
      getComments: vi.fn(async (k: string) => {
        if (k === 'CUST-9') throw new Error('403 comments blocked')
        return []
      })
    }
    const svc = service(client)
    await svc.createFromTicket({ slug: 'NAV-7', title: 'T', key: 'NAV-7' })
    await svc.importSourceTicket('NAV-7', 'CUST-9')
    await settle()

    const summary = await svc.refresh('NAV-7')
    await settle()
    // The ticket text loaded fine (no top-level `error`), but comments 403'd — that
    // must be visible, not swallowed as a fully-successful source.
    expect(summary.sources[0].error).toBeUndefined()
    expect(summary.sources[0].commentsError).toContain('403 comments blocked')
  })

  it('creates a case with source tickets linked and their text ingested', async () => {
    const client: AtlassianClientLike = {
      getIssue: vi.fn(async (k: string) =>
        k === 'CUST-9' ? issue({ key: 'CUST-9', summary: 'Customer', attachments: [] }) : issue()
      ),
      downloadAttachment: vi.fn(async () => {}),
      getComments: vi.fn(async () => [])
    }
    const svc = service(client)
    await svc.createFromTicket({ slug: 'NAV-7', title: 'T', key: 'NAV-7', sources: ['CUST-9'] })
    await settle()

    expect(listCaseJiraLinks(db, 'NAV-7').map((l) => l.key)).toEqual(['CUST-9'])
    expect(listEvidence(db, 'NAV-7').map((e) => e.relPath)).toContain('evidence/CUST-9.ticket.md')
  })

  it('links using the canonical key Jira returns, not the requested key', async () => {
    // OLD-1 was moved/renamed upstream; Jira resolves it to NEW-1 on fetch. Once the link
    // is stored under NEW-1, a later refresh looks it up by NEW-1 too — same as real Jira,
    // which resolves the canonical key to itself.
    const renamed = issue({
      key: 'NEW-1',
      summary: 'Renamed',
      attachments: [att('30001', 'moved.log')]
    })
    const byKey: Record<string, JiraIssueData> = {
      'NAV-7': issue(),
      'OLD-1': renamed,
      'NEW-1': renamed
    }
    const client: AtlassianClientLike = {
      getIssue: vi.fn(async (k: string) => byKey[k]),
      downloadAttachment: vi.fn(async (id: string, dest: string) =>
        fs.writeFileSync(dest, `bytes-of-${id}`)
      ),
      getComments: vi.fn(async () => [])
    }
    const svc = service(client)
    await svc.createFromTicket({ slug: 'NAV-7', title: 'T', key: 'NAV-7' })
    await svc.importSourceTicket('NAV-7', 'OLD-1')
    await settle()

    // The link row stores the CANONICAL key, not the requested one.
    expect(listCaseJiraLinks(db, 'NAV-7').map((l) => l.key)).toEqual(['NEW-1'])

    // A subsequent refresh finds the evidence under the canonical key: no phantom
    // "unknown source" error, and the attachment shows up as new (not lost).
    const summary = await svc.refresh('NAV-7')
    expect(summary.sources[0].key).toBe('NEW-1')
    expect(summary.sources[0].error).toBeUndefined()
    expect(summary.sources[0].newAttachments.map((a) => a.id)).toEqual(['30001'])
  })

  it('dedups a byte-identical attachment ingested from a different ticket, attributing it there', async () => {
    const client: AtlassianClientLike = {
      getIssue: vi.fn(async (k: string) =>
        k === 'CUST-9' ? issue({ key: 'CUST-9', summary: 'Customer', attachments: [] }) : issue()
      ),
      downloadAttachment: vi.fn(async (_id: string, dest: string) => {
        // byte-identical content regardless of which ticket's attachment id is asked for —
        // this is the clone-of-a-customer-ticket scenario the dedup exists for.
        fs.writeFileSync(dest, 'same-bytes')
      }),
      getComments: vi.fn(async () => [])
    }
    const svc = service(client)
    await svc.createFromTicket({ slug: 'NAV-7', title: 'T', key: 'NAV-7' })
    await svc.ingestAttachments('NAV-7', 'NAV-7', [att('10001', 'log.txt')])
    await settle()

    const results = await svc.ingestAttachments('NAV-7', 'CUST-9', [att('20001', 'log.txt')])
    await settle()

    expect(results[0]).toMatchObject({
      attachmentId: '20001',
      status: 'done',
      dedupedFrom: 'NAV-7'
    })
    const ev = listEvidence(db, 'NAV-7')
    // No second evidence row for the same bytes.
    expect(ev.filter((e) => e.relPath.includes('log.txt'))).toHaveLength(1)
    const rec = ev.find((e) => e.relPath === 'evidence/log.txt')!
    expect((rec.meta.jira as { key: string }).key).toBe('NAV-7')
    expect(
      (rec.meta.jira as { alsoOn?: Array<{ key: string; attachmentId: string }> }).alsoOn
    ).toEqual([{ key: 'CUST-9', attachmentId: '20001', filename: 'log.txt' }])
  })

  it('a deduped source attachment is not reported as new on refresh, including a second refresh', async () => {
    const custAtts = [att('20001', 'log.txt')]
    const client: AtlassianClientLike = {
      getIssue: vi.fn(async (k: string) =>
        k === 'CUST-9'
          ? issue({ key: 'CUST-9', summary: 'Customer', attachments: custAtts })
          : issue()
      ),
      downloadAttachment: vi.fn(async (_id: string, dest: string) => {
        fs.writeFileSync(dest, 'same-bytes')
      }),
      getComments: vi.fn(async () => [])
    }
    const svc = service(client)
    await svc.createFromTicket({ slug: 'NAV-7', title: 'T', key: 'NAV-7' })
    await svc.ingestAttachments('NAV-7', 'NAV-7', [att('10001', 'log.txt')])
    await settle()
    await svc.importSourceTicket('NAV-7', 'CUST-9')
    await settle()

    // The user ticks the source's attachment; it dedups against the primary's copy.
    await svc.ingestAttachments('NAV-7', 'CUST-9', custAtts)
    await settle()

    const r1 = await svc.refresh('NAV-7')
    await settle()
    expect(r1.sources[0].newAttachments).toEqual([])

    // Must not reappear on a SECOND refresh either — the dedup attribution has to persist,
    // not just suppress the report once.
    const r2 = await svc.refresh('NAV-7')
    await settle()
    expect(r2.sources[0].newAttachments).toEqual([])
  })

  it('a same-ticket byte-identical duplicate attachment is not reported as new on refresh, including a second refresh', async () => {
    // Accidental double-upload: NAV-7 itself carries a1 and a2, byte-identical, both ticked
    // by the user. a1 ingests normally; a2 must dedup against it AND be recorded so refresh
    // stops offering a2 as new forever (see Finding 1 — the `dupJira.key !== key` guard used
    // to skip recording same-ticket duplicates entirely).
    const atts = [att('10001', 'a1.txt'), att('10002', 'a2.txt')]
    const client: AtlassianClientLike = {
      getIssue: vi.fn(async () => issue({ attachments: atts })),
      downloadAttachment: vi.fn(async (_id: string, dest: string) => {
        fs.writeFileSync(dest, 'same-bytes')
      }),
      getComments: vi.fn(async () => [])
    }
    const svc = service(client)
    await svc.createFromTicket({ slug: 'NAV-7', title: 'T', key: 'NAV-7' })
    await settle()

    const results = await svc.ingestAttachments('NAV-7', 'NAV-7', atts)
    await settle()

    expect(results[0]).toMatchObject({ attachmentId: '10001', status: 'done' })
    expect(results[1]).toMatchObject({
      attachmentId: '10002',
      status: 'done',
      evidenceId: results[0].evidenceId
    })

    const r1 = await svc.refresh('NAV-7')
    await settle()
    expect(r1.newAttachments).toEqual([])

    // Must not reappear on a SECOND refresh either.
    const r2 = await svc.refresh('NAV-7')
    await settle()
    expect(r2.newAttachments).toEqual([])
  })

  it('omits dedupedFrom when the matched evidence row has no Jira provenance at all', async () => {
    // The user manually uploaded a file that happens to be byte-identical to a Jira
    // attachment. The matched row was never "on" any ticket, so the dialog must not claim
    // it was already on the CURRENT ticket (Finding 2) — that message would be false.
    const svc = service(fakeClient(() => issue()))
    await svc.createFromTicket({ slug: 'NAV-7', title: 'T', key: 'NAV-7' })
    await settle()
    ingestContent(
      db,
      argusHome,
      detection,
      createImmediateQueue(db, argusHome),
      'NAV-7',
      'manual.log',
      'bytes-of-10001',
      'upload',
      {}
    )
    await settle()

    const results = await svc.ingestAttachments('NAV-7', 'NAV-7', [att('10001', 'log.txt')])
    await settle()

    expect(results[0]).toMatchObject({ attachmentId: '10001', status: 'done' })
    expect(results[0].dedupedFrom).toBeUndefined()
  })

  it('does not re-extract an archive whose bytes dedup against one already ingested', async () => {
    const srcDir = fs.mkdtempSync(path.join(os.tmpdir(), 'zsrc-'))
    fs.writeFileSync(path.join(srcDir, 'a.txt'), 'a')
    fs.writeFileSync(path.join(srcDir, 'b.txt'), 'b')
    const zipTmp = path.join(os.tmpdir(), `dedup-${Date.now()}.zip`)
    const zip = new Zip()
    zip.addFile(path.join(srcDir, 'a.txt'), 'a.txt')
    zip.addFile(path.join(srcDir, 'b.txt'), 'b.txt')
    await zip.archive(zipTmp)
    const zipBytes = fs.readFileSync(zipTmp)

    const client: AtlassianClientLike = {
      getIssue: vi.fn(async (k: string) =>
        k === 'CUST-9' ? issue({ key: 'CUST-9', summary: 'Customer', attachments: [] }) : issue()
      ),
      downloadAttachment: vi.fn(async (_id: string, dest: string) => {
        fs.writeFileSync(dest, zipBytes)
      }),
      getComments: vi.fn(async () => [])
    }
    const svc = service(client)
    createCase(db, argusHome, { slug: 'nav-7', title: 'T', jiraKey: 'NAV-7' })
    const first = await svc.ingestAttachments('nav-7', 'NAV-7', [
      { id: '20001', filename: 'bundle.zip', size: 9, mimeType: 'application/zip', createdAt: 'c' }
    ])
    await settle()
    expect(first[0]).toMatchObject({ status: 'done', extractedCount: 2 })

    const second = await svc.ingestAttachments('nav-7', 'CUST-9', [
      { id: '30001', filename: 'bundle.zip', size: 9, mimeType: 'application/zip', createdAt: 'c' }
    ])
    await settle()
    expect(second[0]).toMatchObject({ status: 'done', dedupedFrom: 'NAV-7' })
    expect(second[0].extractedCount).toBeUndefined()

    // Only the original extraction's inner files exist — the dedup hit did not re-explode.
    const ev = listEvidence(db, 'nav-7')
    expect(ev.filter((e) => e.meta.extractedFrom)).toHaveLength(2)
  })

  it('still creates the case when a source cannot be read', async () => {
    const client: AtlassianClientLike = {
      getIssue: vi.fn(async (k: string) => {
        if (k === 'CUST-9') throw new Error('403 no access')
        return issue()
      }),
      downloadAttachment: vi.fn(async () => {}),
      getComments: vi.fn(async () => [])
    }
    const svc = service(client)
    const rec = await svc.createFromTicket({
      slug: 'NAV-7',
      title: 'T',
      key: 'NAV-7',
      sources: ['CUST-9']
    })
    await settle()

    expect(rec.jiraKey).toBe('NAV-7')
    expect(listCaseJiraLinks(db, 'NAV-7')).toEqual([])
  })

  it('does not re-offer a declined source attachment as new', async () => {
    const client: AtlassianClientLike = {
      getIssue: vi.fn(async (k: string) =>
        k === 'CUST-9'
          ? issue({ key: 'CUST-9', summary: 'Customer', attachments: [att('20001', 'first.log')] })
          : issue()
      ),
      downloadAttachment: vi.fn(async () => {}),
      getComments: vi.fn(async () => [])
    }
    const svc = service(client)
    await svc.createFromTicket({ slug: 'NAV-7', title: 'T', key: 'NAV-7' })
    await svc.importSourceTicket('NAV-7', 'CUST-9')
    await settle()

    const r1 = await svc.refresh('NAV-7')
    await settle()
    expect(r1.sources[0].newAttachments.map((a) => a.id)).toEqual(['20001'])
    expect(r1.sources[0].deselectedAttachments).toEqual([])

    setCaseJiraLinkDeselected(db, 'NAV-7', 'CUST-9', ['20001'])

    const r2 = await svc.refresh('NAV-7')
    await settle()
    expect(r2.sources[0].newAttachments).toEqual([])
    expect(r2.sources[0].deselectedAttachments.map((a) => a.id)).toEqual(['20001'])
  })
})
