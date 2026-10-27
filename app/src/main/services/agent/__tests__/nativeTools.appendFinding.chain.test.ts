import { it, expect, beforeEach, afterEach, vi } from 'vitest'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import type { DatabaseSync } from 'node:sqlite'
import { openDb } from '../../db'
import { createCase } from '../../caseService'
import { caseDir } from '../../paths'
import { argusToolHandlers, TOOL_FEEDBACK, type NativeToolDeps } from '../nativeTools'
import { listFindings, SUPERSEDED_REASON } from '../../findings'
import type { Detection } from '../../packs/detection'

let home: string
let db: DatabaseSync
let caseId: number
let otherCaseId: number
let emitFindingUpdated: ReturnType<typeof vi.fn<(findingId: number) => void>>

function sessionFor(cid: number, mode: 'investigation' | 'review' = 'investigation'): number {
  const now = new Date().toISOString()
  return Number(
    db
      .prepare(`INSERT INTO sessions (case_id, mode, created_at, updated_at) VALUES (?, ?, ?, ?)`)
      .run(cid, mode, now, now).lastInsertRowid
  )
}

function handlersFor(
  sessionId: number,
  slug = 'CASE-A',
  cid = caseId
): Record<string, (a: Record<string, unknown>) => Promise<string>> {
  const deps: NativeToolDeps = {
    db,
    argusHome: home,
    detection: {} as Detection,
    caseId: cid,
    caseSlug: slug,
    sessionId,
    emitFinding: () => {},
    emitFindingUpdated,
    githubWatermark: () => ({ enabled: false, text: '' })
  }
  return argusToolHandlers(deps)
}

const idOf = (out: string): number => Number(/#(\d+)/.exec(out)![1])
const col = (id: number, name: string): unknown =>
  (db.prepare(`SELECT ${name} AS v FROM findings WHERE id = ?`).get(id) as { v: unknown }).v
const findingsMd = (): string =>
  fs.readFileSync(path.join(caseDir(home, 'CASE-A'), 'findings.md'), 'utf8')

beforeEach(() => {
  home = fs.mkdtempSync(path.join(os.tmpdir(), 'argus-append-chain-'))
  db = openDb(path.join(home, 'argus.db'))
  caseId = createCase(db, home, { slug: 'CASE-A', title: 'A' }).id
  otherCaseId = createCase(db, home, { slug: 'CASE-B', title: 'B' }).id
  emitFindingUpdated = vi.fn()
})
afterEach(() => {
  db.close()
  fs.rmSync(home, { recursive: true, force: true })
})

it('stores status, role (source agent) and caused_by; a bare call stays legacy-shaped', async () => {
  const h = handlersFor(sessionFor(caseId))
  const root = idOf(await h.append_finding({ title: 'Server blocks version', markdown: 'b' }))
  expect(col(root, 'status')).toBeNull()
  expect(col(root, 'role')).toBeNull()
  expect(col(root, 'role_source')).toBeNull()
  const sym = idOf(
    await h.append_finding({
      title: 'Install rejected',
      markdown: 'b',
      status: 'hypothesis',
      role: 'symptom',
      caused_by: root
    })
  )
  const row = listFindings(db, home, 'CASE-A').find((f) => f.id === sym)!
  expect(row.status).toBe('hypothesis')
  expect(row.role).toBe('symptom')
  expect(row.roleSource).toBe('agent')
  expect(row.causedBy).toBe(root)
})

it('refuses a bad status or role, a cross-case or other-mode cause, and a self cause — no row written', async () => {
  const h = handlersFor(sessionFor(caseId))
  await expect(h.append_finding({ title: 't', markdown: 'b', status: 'maybe' })).rejects.toThrow(
    'Unknown status "maybe". Use one of: hypothesis|confirmed.'
  )
  await expect(h.append_finding({ title: 't', markdown: 'b', role: 'boss' })).rejects.toThrow(
    'Unknown role "boss". Use one of: root-cause|contributing|symptom|ruled-out|duplicate.'
  )
  const foreign = idOf(
    await handlersFor(sessionFor(otherCaseId), 'CASE-B', otherCaseId).append_finding({
      title: 'f',
      markdown: 'b'
    })
  )
  await expect(h.append_finding({ title: 't', markdown: 'b', caused_by: foreign })).rejects.toThrow(
    /unknown/i
  )
  const reviewOnly = idOf(
    await handlersFor(sessionFor(caseId, 'review')).append_finding({ title: 'r', markdown: 'b' })
  )
  await expect(
    h.append_finding({ title: 't', markdown: 'b', caused_by: reviewOnly })
  ).rejects.toThrow(/unknown/i)
  expect(listFindings(db, home, 'CASE-A').filter((f) => f.mode === 'investigation')).toHaveLength(0)
})

it('supersedes: retracts the old finding, links it, re-parents its children, and refuses an accepted one', async () => {
  const h = handlersFor(sessionFor(caseId))
  const old = idOf(await h.append_finding({ title: 'Old cause', markdown: 'b' }))
  const child = idOf(await h.append_finding({ title: 'Symptom', markdown: 'b', caused_by: old }))
  const out = await h.append_finding({ title: 'Better cause', markdown: 'b', supersedes: old })
  const fresh = idOf(out)
  expect(out).toBe(`finding appended as #${fresh}`)
  expect(col(old, 'review_state')).toBe('rejected')
  expect(col(old, 'review_reason')).toBe(SUPERSEDED_REASON(fresh))
  expect(col(old, 'superseded_by')).toBe(fresh)
  expect(col(child, 'caused_by')).toBe(fresh)
  expect(emitFindingUpdated).toHaveBeenCalledWith(old)

  db.prepare(`UPDATE findings SET review_state = 'accepted' WHERE id = ?`).run(fresh)
  await expect(
    h.append_finding({ title: 'Again', markdown: 'b', supersedes: fresh })
  ).rejects.toThrow(
    TOOL_FEEDBACK['append_finding.supersedes-accepted'].text.replace('{id}', String(fresh))
  )
  await expect(
    h.append_finding({ title: 'Loop', markdown: 'b', supersedes: child, caused_by: child })
  ).rejects.toThrow(TOOL_FEEDBACK['finding.self-cause'].text)
  expect(listFindings(db, home, 'CASE-A')).toHaveLength(3)
})

it('refuses to supersede a finding that was already replaced, naming its replacement', async () => {
  const h = handlersFor(sessionFor(caseId))
  const old = idOf(await h.append_finding({ title: 'Old cause', markdown: 'b' }))
  const fresh = idOf(await h.append_finding({ title: 'Better', markdown: 'b', supersedes: old }))
  await expect(
    h.append_finding({ title: 'Third', markdown: 'b', supersedes: old })
  ).rejects.toThrow(
    TOOL_FEEDBACK['append_finding.already-superseded'].text
      .replace('{id}', String(old))
      .replace('{by}', String(fresh))
  )
  expect(listFindings(db, home, 'CASE-A')).toHaveLength(2)
})

it('refuses a second confirmed root cause at record time, naming the first', async () => {
  const h = handlersFor(sessionFor(caseId))
  const first = idOf(await h.append_finding({ title: 'Root', markdown: 'b', role: 'root-cause' }))
  await expect(
    h.append_finding({ title: 'Root 2', markdown: 'b', role: 'root-cause' })
  ).rejects.toThrow(
    TOOL_FEEDBACK['finding.second-root'].text.replace(/\{existing\}/g, String(first))
  )
  // A root-cause hypothesis beside it is fine.
  await h.append_finding({
    title: 'Root 2',
    markdown: 'b',
    role: 'root-cause',
    status: 'hypothesis'
  })
  expect(listFindings(db, home, 'CASE-A')).toHaveLength(2)
})

it('lets a sharper confirmed root cause supersede the current one', async () => {
  const h = handlersFor(sessionFor(caseId))
  const first = idOf(await h.append_finding({ title: 'Root', markdown: 'b', role: 'root-cause' }))
  const sharper = idOf(
    await h.append_finding({
      title: 'Root, narrowed',
      markdown: 'b',
      role: 'root-cause',
      status: 'confirmed',
      supersedes: first
    })
  )
  expect(col(first, 'superseded_by')).toBe(sharper)
  expect(col(first, 'review_state')).toBe('rejected')
  expect(col(sharper, 'role')).toBe('root-cause')
})

it('a supersede that fails after the pre-check leaves no half-recorded finding', async () => {
  const h = handlersFor(sessionFor(caseId))
  const old = idOf(await h.append_finding({ title: 'Old cause', markdown: 'b' }))
  const mdBefore = findingsMd()
  // Inject a storage failure inside supersedeFinding's own transaction (after canSupersede passed).
  db.exec(`CREATE TRIGGER fail_supersede BEFORE UPDATE OF superseded_by ON findings
           BEGIN SELECT RAISE(ABORT, 'disk on fire'); END`)
  await expect(
    h.append_finding({ title: 'Better cause', markdown: 'b', supersedes: old })
  ).rejects.toThrow('disk on fire')
  expect(listFindings(db, home, 'CASE-A').map((f) => f.id)).toEqual([old])
  expect(findingsMd()).toBe(mdBefore)
  expect(col(old, 'review_state')).toBe('pending')
  expect(col(old, 'superseded_by')).toBeNull()
  expect(emitFindingUpdated).not.toHaveBeenCalled()
})

it('a review session passing a chain arg is refused before anything is written; a plain review finding still records', async () => {
  const rev = handlersFor(sessionFor(caseId, 'review'))
  const inv = idOf(
    await handlersFor(sessionFor(caseId)).append_finding({
      title: 'Cache key collision',
      markdown: 'b'
    })
  )
  const before = findingsMd()
  const refusal = TOOL_FEEDBACK['append_finding.review-mode'].text
  for (const chain of [
    { role: 'root-cause' },
    { status: 'hypothesis' },
    { caused_by: inv },
    // Pointing at an investigation finding the review session cannot see: the mode guard fires
    // first, so neither the supersede nor its retraction of the investigation finding happens.
    { supersedes: inv }
  ]) {
    await expect(
      rev.append_finding({ title: 'Unchecked null', markdown: 'b', ...chain })
    ).rejects.toThrow(refusal)
  }
  expect(listFindings(db, home, 'CASE-A').filter((f) => f.mode === 'review')).toHaveLength(0)
  expect(findingsMd()).toBe(before)
  expect(col(inv, 'review_state')).toBe('pending')
  expect(col(inv, 'superseded_by')).toBeNull()
  expect(emitFindingUpdated).not.toHaveBeenCalled()
  const plain = idOf(await rev.append_finding({ title: 'Unchecked null', markdown: 'b' }))
  expect(col(plain, 'role')).toBeNull()
  expect(col(plain, 'status')).toBeNull()
})

it('a review-mode root-cause row does not block the investigation root', async () => {
  const now = new Date().toISOString()
  const rev = sessionFor(caseId, 'review')
  db.prepare(
    `INSERT INTO findings (case_id, session_id, summary, review_state, created_at, role, status)
     VALUES (?, ?, 'Review-side root', 'pending', ?, 'root-cause', 'confirmed')`
  ).run(caseId, rev, now)
  const h = handlersFor(sessionFor(caseId))
  const root = idOf(
    await h.append_finding({ title: 'Stale token cache', markdown: 'b', role: 'root-cause' })
  )
  expect(col(root, 'role')).toBe('root-cause')
})

it('escapes a finding marker inside a model-written body so findings.md keeps one block per finding', async () => {
  const h = handlersFor(sessionFor(caseId))
  const id = idOf(
    await h.append_finding({
      title: 'Quoted',
      markdown: 'see <!-- finding:99 --> and <!--finding:1-->'
    })
  )
  const rows = listFindings(db, home, 'CASE-A')
  expect(rows).toHaveLength(1)
  expect(rows[0].body?.trim()).toBe('see <!-- finding-ref:99 --> and <!-- finding-ref:1 -->')
  expect(
    fs
      .readFileSync(path.join(caseDir(home, 'CASE-A'), 'findings.md'), 'utf8')
      .split('<!-- finding:')
  ).toHaveLength(2)
  void id
})
