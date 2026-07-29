import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import type { DatabaseSync } from 'node:sqlite'
import { openDb } from '../../db'
import { writeProposal, acceptProposal, rejectProposal } from '../../proposals'
import { buildEvalBundle, exportEvalBundle } from '../evalExport'

let home: string
let db: DatabaseSync
beforeEach(() => {
  home = fs.mkdtempSync(path.join(os.tmpdir(), 'argus-eval-'))
  db = openDb(path.join(home, 'argus.db'))
})
afterEach(() => {
  db.close()
  fs.rmSync(home, { recursive: true, force: true })
})

const SNAPSHOT = JSON.stringify({ caseMeta: { slug: 'nav-1' } })

function insertJob(over: Partial<Record<string, unknown>> = {}): number {
  const r = db
    .prepare(
      `INSERT INTO distill_jobs (case_slug, state, input_snapshot, raw_output, error, prompt_hash, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?)`
    )
    .run(
      (over.case_slug as string) ?? 'nav-1',
      (over.state as string) ?? 'done',
      (over.input_snapshot as string) ?? SNAPSHOT,
      (over.raw_output as string | null) ?? '```json\n{}\n```',
      (over.error as string | null) ?? null,
      (over.prompt_hash as string | null) ?? 'abc123def456',
      (over.created_at as string) ?? '2026-07-29T00:00:00.000Z'
    )
  return Number(r.lastInsertRowid)
}

/** Stage one job-stamped proposal and archive it with the given outcome. */
function reviewedItem(
  jobId: number,
  outcome: 'accepted' | 'rejected',
  reason?: { tag: 'overgeneric'; note?: string }
): string {
  const f = writeProposal(
    home,
    'nav-1',
    { type: 'skill-new', target: `s-${jobId}-${outcome}`, title: 't', content: '# s\n' },
    { job: String(jobId) }
  )
  if (outcome === 'accepted') acceptProposal(home, f)
  else rejectProposal(home, f, reason)
  return f
}

describe('buildEvalBundle', () => {
  it('exports a fully-reviewed done job with outcomes and reject labels', () => {
    const id = insertJob()
    reviewedItem(id, 'accepted')
    reviewedItem(id, 'rejected', { tag: 'overgeneric', note: 'too vague' })
    const { lines, skipped } = buildEvalBundle(db, home, '1.0.0')
    expect(skipped).toEqual([])
    expect(lines).toHaveLength(1)
    expect(lines[0].job.id).toBe(id)
    expect(lines[0].job.promptHash).toBe('abc123def456')
    expect(lines[0].job.inputSnapshot.caseMeta.slug).toBe('nav-1')
    const outcomes = lines[0].items.map((i) => i.outcome).sort()
    expect(outcomes).toEqual(['accepted', 'rejected'])
    const rejectedItem = lines[0].items.find((i) => i.outcome === 'rejected')!
    expect(rejectedItem.rejectReason).toBe('overgeneric')
    expect(rejectedItem.rejectNote).toBe('too vague')
  })

  it('skips a done job that still has a pending job-stamped item', () => {
    const id = insertJob()
    writeProposal(
      home,
      'nav-1',
      { type: 'skill-new', target: 's1', title: 't', content: '# s\n' },
      { job: String(id) }
    )
    const { lines, skipped } = buildEvalBundle(db, home, '1.0.0')
    expect(lines).toEqual([])
    expect(skipped).toEqual([{ jobId: id, caseSlug: 'nav-1', reason: 'items pending review' }])
  })

  it('exports a parse-failed job with empty items', () => {
    const id = insertJob({
      state: 'failed',
      raw_output: 'NOT JSON',
      error: 'expected exactly 1 json fence, got 0'
    })
    const { lines } = buildEvalBundle(db, home, '1.0.0')
    expect(lines).toHaveLength(1)
    expect(lines[0].job.id).toBe(id)
    expect(lines[0].job.state).toBe('failed')
    expect(lines[0].items).toEqual([])
  })

  it('skips a failed job without output, and only considers the latest job per case', () => {
    insertJob({ state: 'failed', raw_output: null, error: 'app quit mid-distill' }) // older
    const latest = insertJob() // newer, done, no items → exports with items: []
    const { lines, skipped } = buildEvalBundle(db, home, '1.0.0')
    expect(lines.map((l) => l.job.id)).toEqual([latest])
    expect(skipped).toEqual([]) // the older job is superseded, not "skipped"
  })

  it('ignores contribute-back archives (no job stamp)', () => {
    insertJob()
    const f = writeProposal(home, 'nav-1', {
      type: 'skill-new',
      target: 'user-authored',
      title: 't',
      content: '# s\n'
    })
    rejectProposal(home, f, { tag: 'wrong' })
    const { lines } = buildEvalBundle(db, home, '1.0.0')
    expect(lines).toHaveLength(1)
    expect(lines[0].items).toEqual([])
  })
})

describe('exportEvalBundle', () => {
  it('writes one JSON line per exported job', () => {
    const id = insertJob()
    reviewedItem(id, 'rejected', { tag: 'overgeneric' })
    const dest = path.join(home, 'bundle.ndjson')
    const res = exportEvalBundle(db, home, dest, '1.0.0')
    expect(res).toMatchObject({ path: dest, exported: 1, skipped: [] })
    const parsed = fs
      .readFileSync(dest, 'utf8')
      .trim()
      .split('\n')
      .map((l) => JSON.parse(l))
    expect(parsed).toHaveLength(1)
    expect(parsed[0].job.id).toBe(id)
    expect(parsed[0].argusVersion).toBe('1.0.0')
  })
})
