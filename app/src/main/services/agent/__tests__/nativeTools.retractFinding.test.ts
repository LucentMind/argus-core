import { it, expect, beforeEach, afterEach, vi } from 'vitest'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import type { DatabaseSync } from 'node:sqlite'
import { openDb } from '../../db'
import { createCase } from '../../caseService'
import { argusToolHandlers, type NativeToolDeps } from '../nativeTools'
import { listFindings, reviewFinding } from '../../findings'
import { writeAttributions } from '../../distill/attributions'
import type { AttributionRow } from '../../../../shared/attribution'
import type { Detection } from '../../packs/detection'

let home: string
let db: DatabaseSync
let caseId: number
let otherCaseId: number
let emitFindingUpdated: ReturnType<typeof vi.fn<(findingId: number) => void>>

function sessionFor(cid: number, mode: 'investigation' | 'review'): number {
  const now = new Date().toISOString()
  const res = db
    .prepare(`INSERT INTO sessions (case_id, mode, created_at, updated_at) VALUES (?, ?, ?, ?)`)
    .run(cid, mode, now, now)
  return Number(res.lastInsertRowid)
}

function handlersFor(
  sessionId: number,
  slug = 'CASE-A',
  cid = caseId,
  extra: Partial<NativeToolDeps> = {}
): Record<string, (args: Record<string, unknown>) => Promise<string>> {
  const deps: NativeToolDeps = {
    db,
    argusHome: home,
    detection: {} as Detection,
    caseId: cid,
    caseSlug: slug,
    sessionId,
    emitFinding: () => {},
    emitFindingUpdated,
    githubWatermark: () => ({ enabled: false, text: '' }),
    ...extra
  }
  return argusToolHandlers(deps)
}

beforeEach(() => {
  home = fs.mkdtempSync(path.join(os.tmpdir(), 'argus-retract-tool-'))
  db = openDb(path.join(home, 'argus.db'))
  caseId = createCase(db, home, { slug: 'CASE-A', title: 'A' }).id
  otherCaseId = createCase(db, home, { slug: 'CASE-B', title: 'B' }).id
  emitFindingUpdated = vi.fn()
})

afterEach(() => {
  db.close()
  fs.rmSync(home, { recursive: true, force: true })
})

it('list_findings shows id, state, flavor, anchor and title', async () => {
  const s = sessionFor(caseId, 'review')
  const h = handlersFor(s)
  await h.append_finding({
    title: 'Race in parser',
    markdown: 'Torn buffer at [src/a.ts:3] under concurrent readers.',
    layer: 'correctness',
    severity: 'major'
  })
  const out = await h.list_findings({})
  expect(out).toMatch(/^#\d+ · pending · major\/correctness · src\/a\.ts:3 · Race in parser$/m)
})

it('list_findings shows only the session mode findings', async () => {
  const review = sessionFor(caseId, 'review')
  const inv = sessionFor(caseId, 'investigation')
  await handlersFor(review).append_finding({ title: 'Review one', markdown: 'r' })
  await handlersFor(inv).append_finding({ title: 'Investigation one', markdown: 'i' })
  const out = await handlersFor(review).list_findings({})
  expect(out).toContain('Review one')
  expect(out).not.toContain('Investigation one')
})

it('retract_finding marks it rejected by the agent and emits the update', async () => {
  const s = sessionFor(caseId, 'investigation')
  const h = handlersFor(s)
  await h.append_finding({ title: 'Wrong call site', markdown: 'see [src/a.ts:1]' })
  const id = (
    db.prepare(`SELECT id FROM findings ORDER BY id DESC LIMIT 1`).get() as { id: number }
  ).id
  await h.retract_finding({ finding_id: id, reason: 'the guard is in the caller' })
  const row = listFindings(db, home, 'CASE-A').find((f) => f.id === id)
  expect(row?.reviewState).toBe('rejected')
  expect(row?.reviewActor).toBe('agent')
  expect(row?.reviewReason).toBe('the guard is in the caller')
  expect(emitFindingUpdated).toHaveBeenCalledWith(id)
})

it('retract_finding refuses a human-accepted finding', async () => {
  const s = sessionFor(caseId, 'investigation')
  const h = handlersFor(s)
  await h.append_finding({ title: 'Confirmed', markdown: 'see [src/a.ts:1]' })
  const id = (
    db.prepare(`SELECT id FROM findings ORDER BY id DESC LIMIT 1`).get() as { id: number }
  ).id
  db.prepare(
    `UPDATE findings SET review_state = 'accepted', review_actor = 'human' WHERE id = ?`
  ).run(id)
  await expect(h.retract_finding({ finding_id: id, reason: 'nope' })).rejects.toThrow(/accepted/i)
  expect(emitFindingUpdated).not.toHaveBeenCalled()
})

it('retract_finding rejects an empty reason before writing anything', async () => {
  const s = sessionFor(caseId, 'investigation')
  const h = handlersFor(s)
  await h.append_finding({ title: 'Wrong', markdown: 'see [src/a.ts:1]' })
  const id = (
    db.prepare(`SELECT id FROM findings ORDER BY id DESC LIMIT 1`).get() as { id: number }
  ).id
  await expect(h.retract_finding({ finding_id: id, reason: '   ' })).rejects.toThrow(/reason/i)
  expect(listFindings(db, home, 'CASE-A').find((f) => f.id === id)?.reviewState).toBe('pending')
})

it('retract_finding cannot reach another case findings', async () => {
  const other = sessionFor(otherCaseId, 'investigation')
  await handlersFor(other, 'CASE-B', otherCaseId).append_finding({
    title: 'Other case',
    markdown: 'x'
  })
  const id = (
    db.prepare(`SELECT id FROM findings ORDER BY id DESC LIMIT 1`).get() as { id: number }
  ).id
  const mine = handlersFor(sessionFor(caseId, 'investigation'))
  await expect(mine.retract_finding({ finding_id: id, reason: 'wrong' })).rejects.toThrow(
    /^Unknown finding id\.$/
  )
  expect(listFindings(db, home, 'CASE-B').find((f) => f.id === id)?.reviewState).toBe('pending')
})

it('retract_finding refuses a finding already rejected by a human without overwriting it', async () => {
  const s = sessionFor(caseId, 'investigation')
  const h = handlersFor(s)
  await h.append_finding({ title: 'Bad guess', markdown: 'see [src/a.ts:1]' })
  const id = (
    db.prepare(`SELECT id FROM findings ORDER BY id DESC LIMIT 1`).get() as { id: number }
  ).id
  db.prepare(
    `UPDATE findings SET review_state = 'rejected', review_actor = 'human', review_reason = ?, reviewed_at = ? WHERE id = ?`
  ).run('not what the log says', new Date().toISOString(), id)
  const out = await h.retract_finding({ finding_id: id, reason: 'agent wording' })
  expect(out).toMatch(/already.*rejected by a human/i)
  expect(emitFindingUpdated).not.toHaveBeenCalled()
  const row = listFindings(db, home, 'CASE-A').find((f) => f.id === id)
  expect(row?.reviewActor).toBe('human')
  expect(row?.reviewReason).toBe('not what the log says')
})

it('retract_finding cannot reach an investigation finding from a review session', async () => {
  const inv = sessionFor(caseId, 'investigation')
  await handlersFor(inv).append_finding({ title: 'Investigation finding', markdown: 'x' })
  const id = (
    db.prepare(`SELECT id FROM findings ORDER BY id DESC LIMIT 1`).get() as { id: number }
  ).id
  const review = handlersFor(sessionFor(caseId, 'review'))
  await expect(review.retract_finding({ finding_id: id, reason: 'wrong' })).rejects.toThrow(
    /^Unknown finding id\.$/
  )
  expect(listFindings(db, home, 'CASE-A').find((f) => f.id === id)?.reviewState).toBe('pending')
})

it('retract_finding hands an implicit attribution override to deps.emitAttributions', async () => {
  const s = sessionFor(caseId, 'investigation')
  const emitAttributions = vi.fn<(rows: AttributionRow[]) => void>()
  const h = handlersFor(s, 'CASE-A', caseId, { emitAttributions })
  await h.append_finding({ title: 'Stale threshold', markdown: 'see [src/a.ts:1]' })
  const id = (
    db.prepare(`SELECT id FROM findings ORDER BY id DESC LIMIT 1`).get() as { id: number }
  ).id
  const jobId = Number(
    db
      .prepare(
        `INSERT INTO distill_jobs (case_slug, state, input_snapshot, created_at) VALUES ('CASE-A', 'done', '{}', 'x')`
      )
      .run().lastInsertRowid
  )
  writeAttributions(db, {
    caseSlug: 'CASE-A',
    jobId,
    verdicts: [
      {
        kind: 'reference',
        name: 'nav/limits.md',
        applied: true,
        verdict: 'neutral',
        reason: '',
        cites: []
      }
    ],
    tiers: new Map(),
    caseOutcome: 'open',
    caseDomain: 'unassigned',
    judgeModel: 'm',
    promptHash: 'h'
  })
  await h.retract_finding({ finding_id: id, reason: 'ref:nav/limits.md gave a stale threshold' })
  expect(emitAttributions).toHaveBeenCalledTimes(1)
  expect(emitAttributions.mock.calls[0][0]).toHaveLength(1)
  expect(emitAttributions.mock.calls[0][0][0]).toMatchObject({
    assetName: 'nav/limits.md',
    overrideSource: 'finding-retraction'
  })
})

it('list_findings shows the human reject tag so the agent sees why it was turned down', async () => {
  const s = sessionFor(caseId, 'investigation')
  const h = handlersFor(s)
  await h.append_finding({ title: 'Race in parser', markdown: 'r' })
  const id = listFindings(db, home, 'CASE-A')[0].id
  reviewFinding(db, id, 'rejected', { tag: 'wrong', note: 'log is from the old build' })
  const out = await h.list_findings({})
  expect(out).toContain(`#${id} · rejected · wrong: log is from the old build · Race in parser`)
})
