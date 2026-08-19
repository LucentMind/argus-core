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
      `INSERT INTO distill_jobs (case_slug, state, input_snapshot, raw_output, error, prompt_hash, created_at, kind, stages_json, dropped_json)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
    )
    .run(
      (over.case_slug as string) ?? 'nav-1',
      (over.state as string) ?? 'done',
      (over.input_snapshot as string) ?? SNAPSHOT,
      (over.raw_output as string | null) ?? '```json\n{}\n```',
      (over.error as string | null) ?? null,
      (over.prompt_hash as string | null) ?? 'abc123def456',
      (over.created_at as string) ?? '2026-07-29T00:00:00.000Z',
      (over.kind as string) ?? 'case',
      (over.stages_json as string | null) ?? null,
      (over.dropped_json as string | null) ?? null
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
    // A valid skill body: acceptProposal validates it, and a bare '# s\n' would be refused
    // for an empty description. The frontmatter `name:` is stamped from the target on accept.
    {
      type: 'skill-new',
      target: `s-${jobId}-${outcome}`,
      title: 't',
      content: '---\ndescription: Use when exercising the eval-bundle export.\n---\n\n# s\n'
    },
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

  it('F5: a cancelled re-distill does not hide an earlier fully-reviewed done job', () => {
    // A cancelled job never reaches stage() (see DistillQueue.cancel / runJob's aborted-path
    // guards), so it never ran the supersede step that deletes an earlier job's un-archived
    // proposals — the earlier `done` job's archived outcome set is still structurally complete.
    // The MAX(id) subquery must not let the cancelled row shadow it as "latest".
    const doneId = insertJob({ created_at: '2026-07-29T00:00:00.000Z' })
    reviewedItem(doneId, 'accepted')
    insertJob({ state: 'cancelled', raw_output: null, created_at: '2026-07-30T00:00:00.000Z' })
    const { lines, skipped } = buildEvalBundle(db, home, '1.0.0')
    expect(lines.map((l) => l.job.id)).toEqual([doneId])
    expect(lines[0].items.map((i) => i.outcome)).toEqual(['accepted'])
    expect(skipped).toEqual([])
  })

  it('skips a queued job (latest for its case) as not finished', () => {
    const id = insertJob({ state: 'queued', raw_output: null, prompt_hash: null })
    const { lines, skipped } = buildEvalBundle(db, home, '1.0.0')
    expect(lines).toEqual([])
    expect(skipped).toEqual([{ jobId: id, caseSlug: 'nav-1', reason: 'not finished' }])
  })

  it('exports the real job, not a newer dry one', () => {
    // Arrange: one done case job, then a newer done DRY job for the same case.
    const realJobId = insertJob({ created_at: '2026-08-19T10:00:00.000Z' })
    reviewedItem(realJobId, 'accepted')
    db.prepare(
      `INSERT INTO distill_jobs (case_slug, state, input_snapshot, raw_output, item_count, created_at, dry_run)
       VALUES ('nav-1', 'done', '{}', '{}', NULL, '2026-08-19T11:00:00.000Z', 1)`
    ).run()
    const { lines } = buildEvalBundle(db, home, '1.0.0')
    expect(lines).toHaveLength(1)
    expect(lines[0].job.caseSlug).toBe('nav-1')
    // The surviving line must be the REAL job — assert on its id, not just the count.
    expect(lines[0].job.id).toBe(realJobId)
  })

  it('a reject-digest row does not shadow the case job as MAX(id), and is not itself exported', () => {
    const doneId = insertJob({ created_at: '2026-07-29T00:00:00.000Z' })
    reviewedItem(doneId, 'accepted')
    // Higher id, same slug, kind='reject-digest' — must be invisible to the MAX(id) subselect.
    insertJob({
      kind: 'reject-digest',
      created_at: '2026-07-30T00:00:00.000Z',
      raw_output: null,
      prompt_hash: null
    })
    const { lines, skipped } = buildEvalBundle(db, home, '1.0.0')
    expect(lines.map((l) => l.job.id)).toEqual([doneId])
    expect(lines[0].items.map((i) => i.outcome)).toEqual(['accepted'])
    expect(skipped).toEqual([])
  })

  it('carries editedContent (the post-delimiter accepted text) and basis when present, and fabricates neither when absent', () => {
    const id = insertJob()
    // basis via staging-shaped extraFm; accept with edits so the item gains editedContent too.
    const f = writeProposal(
      home,
      'nav-1',
      {
        type: 'skill-new',
        target: `s-${id}-edited`,
        title: 't',
        content: '---\ndescription: Use when exercising the eval-bundle export.\n---\n\n# draft\n'
      },
      { job: String(id), basis: 'evidence-123' }
    )
    acceptProposal(home, f, {
      editedContent:
        '---\ndescription: Use when exercising the eval-bundle export.\n---\n\n# edited\n'
    })
    reviewedItem(id, 'rejected', { tag: 'overgeneric' }) // unedited sibling — no basis, no editedContent

    const { lines } = buildEvalBundle(db, home, '1.0.0')
    expect(lines).toHaveLength(1)
    const edited = lines[0].items.find((i) => i.target === `s-${id}-edited`)!
    expect(edited.basis).toBe('evidence-123')
    expect(edited.editedContent).toContain('# edited')
    expect(edited.editedContent).not.toContain('# draft')

    const unedited = lines[0].items.find((i) => i.outcome === 'rejected')!
    expect(unedited.basis).toBeUndefined()
    expect(unedited.editedContent).toBeUndefined()
    expect('basis' in unedited).toBe(false)
    expect('editedContent' in unedited).toBe(false)
  })

  it('an accepted item with basis but no edit carries basis and no editedContent key at all', () => {
    const id = insertJob()
    const f = writeProposal(
      home,
      'nav-1',
      {
        type: 'skill-new',
        target: `s-${id}-basis-only`,
        title: 't',
        content: '---\ndescription: Use when exercising the eval-bundle export.\n---\n\n# draft\n'
      },
      { job: String(id), basis: 'evidence-456' }
    )
    acceptProposal(home, f) // no editedContent — an unedited accept

    const { lines } = buildEvalBundle(db, home, '1.0.0')
    const item = lines[0].items.find((i) => i.target === `s-${id}-basis-only`)!
    expect(item.basis).toBe('evidence-456')
    expect(item.editedContent).toBeUndefined()
    expect('editedContent' in item).toBe(false)
  })

  it('splits on the LAST delimiter occurrence, so a draft that itself contains the literal delimiter cannot smuggle a fake split point', () => {
    const id = insertJob()
    // The draft body itself contains the literal accepted-content delimiter (adversarial or
    // just coincidental) followed by decoy text — a naive first-occurrence split would treat
    // that decoy as the "accepted" half. archive() always appends the REAL delimiter after this
    // whole draft, so the real one is provably the LAST occurrence in the archived file.
    const poisonedDraft =
      '---\ndescription: Use when exercising the eval-bundle export.\n---\n\n' +
      '# draft\nsome text\n<!-- accepted-content -->\nDECOY TEXT THAT SHOULD NOT WIN\n'
    const f = writeProposal(
      home,
      'nav-1',
      { type: 'skill-new', target: `s-${id}-poisoned`, title: 't', content: poisonedDraft },
      { job: String(id) }
    )
    acceptProposal(home, f, {
      editedContent:
        '---\ndescription: Use when exercising the eval-bundle export.\n---\n\n# real edited content\n'
    })

    const { lines } = buildEvalBundle(db, home, '1.0.0')
    const item = lines[0].items.find((i) => i.target === `s-${id}-poisoned`)!
    expect(item.editedContent).toContain('# real edited content')
    expect(item.editedContent).not.toContain('DECOY TEXT')
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

describe('buildEvalBundle — stages', () => {
  it('carries stages from stages_json when present, and leaves it undefined when the column is NULL', () => {
    const withStages = insertJob({
      case_slug: 'nav-1',
      stages_json: '{"dossier":{"promptHash":"h","promptChars":1,"rawOutput":"x"}}'
    })
    const withoutStages = insertJob({ case_slug: 'nav-2', stages_json: null })
    const { lines } = buildEvalBundle(db, home, '1.0.0')
    const l1 = lines.find((l) => l.job.id === withStages)!
    expect(l1.job.stages?.dossier?.promptHash).toBe('h')
    const l2 = lines.find((l) => l.job.id === withoutStages)!
    expect(l2.job.stages).toBeUndefined()
  })

  it('carries dropped_json verbatim, and leaves it undefined when the column is NULL', () => {
    // Everything the run produced but never staged — without it the corpus shows only what
    // survived, and a reused replay line can say nothing about where items were lost.
    const drops = [
      { type: 'skill-new', target: 'diagnose-x', title: 'dup', reason: 'target-exists' },
      { type: 'reference-edit', target: 'r1', title: 'thin', reason: 'basis' }
    ]
    const withDrops = insertJob({ case_slug: 'nav-1', dropped_json: JSON.stringify(drops) })
    const withoutDrops = insertJob({ case_slug: 'nav-2', dropped_json: null })
    const { lines } = buildEvalBundle(db, home, '1.0.0')
    expect(lines.find((l) => l.job.id === withDrops)!.job.dropped).toEqual(drops)
    expect(lines.find((l) => l.job.id === withoutDrops)!.job.dropped).toBeUndefined()
  })
})

describe('exportEvalBundle', () => {
  it('writes one JSON line per exported job', () => {
    const id = insertJob()
    reviewedItem(id, 'rejected', { tag: 'overgeneric' })
    const dest = path.join(home, 'bundle.ndjson')
    const res = exportEvalBundle(db, home, dest, '1.0.0')
    expect(res).toMatchObject({ path: dest, exported: 1, skipped: [], warnings: [] })
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

describe('explicit job ids', () => {
  it('exports a non-latest job when asked for it by id', () => {
    // Two done jobs for one case: the default MAX(id) path would only ever surface `newerId`.
    const olderId = insertJob({ created_at: '2026-08-19T00:00:00.000Z' })
    reviewedItem(olderId, 'accepted')
    const newerId = insertJob({ created_at: '2026-08-19T01:00:00.000Z' })
    reviewedItem(newerId, 'rejected', { tag: 'overgeneric' })

    const res = buildEvalBundle(db, home, '1.0.0', undefined, { jobIds: [olderId] })
    expect(res.lines.map((l) => l.job.id)).toEqual([olderId])
    // Sanity: without the opt, the older job would NOT be the one exported.
    const defaultRes = buildEvalBundle(db, home, '1.0.0')
    expect(defaultRes.lines.map((l) => l.job.id)).toEqual([newerId])
  })

  it('omitting opts is byte-identical to passing {}, and both pin the real default-path behaviour (MAX(id) selection, dry-row exclusion, skip reasons)', () => {
    // case A: two real jobs for one case — the default query's MAX(id) subselect must pick the
    // newer job, not the older one.
    const olderA = insertJob({ case_slug: 'nav-1', created_at: '2026-08-19T00:00:00.000Z' })
    reviewedItem(olderA, 'accepted')
    const newerA = insertJob({ case_slug: 'nav-1', created_at: '2026-08-19T01:00:00.000Z' })
    reviewedItem(newerA, 'rejected', { tag: 'overgeneric', note: 'too vague' })

    // case B: a real job followed by a newer DRY job — the default query's `dry_run = 0` filter
    // must keep the dry row out of the MAX(id) pool entirely, so the real (older) job still
    // surfaces instead of being shadowed by the dry one and both ending up unexported.
    const realB = insertJob({ case_slug: 'nav-2', created_at: '2026-08-19T00:00:00.000Z' })
    reviewedItem(realB, 'accepted')
    db.prepare(
      `INSERT INTO distill_jobs (case_slug, state, input_snapshot, raw_output, item_count, created_at, dry_run)
       VALUES ('nav-2', 'done', '{}', '{}', NULL, '2026-08-19T01:00:00.000Z', 1)`
    ).run()

    // case C: a done job with a still-pending job-stamped proposal — must be skipped with a
    // named reason (not silently dropped, and not turned into a warning: that only happens
    // under explicit jobIds).
    const pendingC = insertJob({ case_slug: 'nav-3', created_at: '2026-08-19T00:00:00.000Z' })
    writeProposal(
      home,
      'nav-3',
      { type: 'skill-new', target: 's-pending', title: 't', content: '# s\n' },
      { job: String(pendingC) }
    )

    const now = (): Date => new Date('2026-08-19T12:00:00.000Z')
    const omitted = buildEvalBundle(db, home, '1.0.0', now)
    const explicitEmpty = buildEvalBundle(db, home, '1.0.0', now, {})

    // Eliding `opts` and passing `{}` must still agree byte-for-byte...
    expect(JSON.stringify(omitted)).toBe(JSON.stringify(explicitEmpty))

    // ...and the shared result they agree on must be the REAL default behaviour, not two
    // stubs that happen to match each other.
    expect(omitted.lines.map((l) => l.job.id)).toEqual([newerA, realB].sort((a, b) => a - b))
    const lineA = omitted.lines.find((l) => l.job.id === newerA)!
    expect(lineA.items.map((i) => i.outcome)).toEqual(['rejected'])
    const lineB = omitted.lines.find((l) => l.job.id === realB)!
    expect(lineB.items.map((i) => i.outcome)).toEqual(['accepted'])
    expect(omitted.skipped).toEqual([
      { jobId: pendingC, caseSlug: 'nav-3', reason: 'items pending review' }
    ])
    expect(omitted.warnings).toEqual([])
  })

  it('exports a pending-review job with a warning instead of skipping it', () => {
    const pendingReviewJobId = insertJob()
    writeProposal(
      home,
      'nav-1',
      { type: 'skill-new', target: 's-pending', title: 't', content: '# s\n' },
      { job: String(pendingReviewJobId) }
    )

    const res = buildEvalBundle(db, home, '1.0.0', undefined, { jobIds: [pendingReviewJobId] })
    expect(res.lines.map((l) => l.job.id)).toEqual([pendingReviewJobId])
    expect(res.skipped.find((s) => s.jobId === pendingReviewJobId)).toBeUndefined()
    expect(res.warnings).toEqual([
      { jobId: pendingReviewJobId, caseSlug: 'nav-1', reason: 'items pending review' }
    ])
  })

  it('names a dry job id as an error rather than silently dropping it', () => {
    // insertJob() has no dry_run column — raw SQL, same as the "exports the real job, not a
    // newer dry one" test above.
    const r = db
      .prepare(
        `INSERT INTO distill_jobs (case_slug, state, input_snapshot, raw_output, item_count, created_at, dry_run)
         VALUES ('nav-1', 'done', '{}', '{}', NULL, '2026-08-19T11:00:00.000Z', 1)`
      )
      .run()
    const dryJobId = Number(r.lastInsertRowid)

    const res = buildEvalBundle(db, home, '1.0.0', undefined, { jobIds: [dryJobId] })
    expect(res.lines).toEqual([])
    expect(res.skipped).toEqual([
      { jobId: dryJobId, caseSlug: 'nav-1', reason: 'dry run — no staged items to judge' }
    ])
  })
})
