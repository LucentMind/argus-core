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
