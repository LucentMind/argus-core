import { it, expect, beforeEach, afterEach, vi } from 'vitest'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import type { DatabaseSync } from 'node:sqlite'
import { openDb } from '../../db'
import { createCase } from '../../caseService'
import { caseDir } from '../../paths'
import {
  argusToolHandlers,
  NATIVE_TOOL_SPECS,
  TOOL_FEEDBACK,
  type NativeToolDeps
} from '../nativeTools'
import { NATIVE_RISK } from '../risk'
import { listFindings, reviewFinding } from '../../findings'
import { FINDING_TREE_HEADINGS } from '../../findingTreeHeadings'
import type { Detection } from '../../packs/detection'

let home: string
let db: DatabaseSync
let caseId: number
let emitFindingUpdated: ReturnType<typeof vi.fn<(findingId: number) => void>>

function sessionFor(mode: 'investigation' | 'review' = 'investigation'): number {
  const now = new Date().toISOString()
  return Number(
    db
      .prepare(`INSERT INTO sessions (case_id, mode, created_at, updated_at) VALUES (?, ?, ?, ?)`)
      .run(caseId, mode, now, now).lastInsertRowid
  )
}
function handlersFor(
  sessionId: number
): Record<string, (a: Record<string, unknown>) => Promise<string>> {
  const deps: NativeToolDeps = {
    db,
    argusHome: home,
    detection: {} as Detection,
    caseId,
    caseSlug: 'CASE-A',
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

beforeEach(() => {
  home = fs.mkdtempSync(path.join(os.tmpdir(), 'argus-update-tool-'))
  db = openDb(path.join(home, 'argus.db'))
  caseId = createCase(db, home, { slug: 'CASE-A', title: 'A' }).id
  emitFindingUpdated = vi.fn()
})
afterEach(() => {
  db.close()
  fs.rmSync(home, { recursive: true, force: true })
})

it('replace_markdown rewrites the body and refuses when append_markdown is passed too', async () => {
  const h = handlersFor(sessionFor())
  const id = idOf(
    await h.append_finding({ title: 'Cited', markdown: 'wrong [evidence/.derived/x.txt:2]' })
  )
  expect(
    await h.update_finding({ finding_id: id, replace_markdown: 'right [evidence/x.txt:2]' })
  ).toBe(`finding #${id} updated`)
  expect(
    listFindings(db, home, 'CASE-A')
      .find((f) => f.id === id)
      ?.body?.trim()
  ).toBe('right [evidence/x.txt:2]')
  await expect(
    h.update_finding({ finding_id: id, append_markdown: 'a', replace_markdown: 'b' })
  ).rejects.toThrow(TOOL_FEEDBACK['update_finding.both-bodies'].text)
  expect(TOOL_FEEDBACK['update_finding.empty'].text).toContain('replace_markdown')
  expect(TOOL_FEEDBACK['update_finding.accepted-locked'].text).toContain('replace_markdown')
})

it('is advertised as a LOW/allow tool with the documented args', () => {
  const spec = NATIVE_TOOL_SPECS.find((s) => s.name === 'update_finding')!
  expect(Object.keys(spec.schema).sort()).toEqual([
    'append_markdown',
    'caused_by',
    'finding_id',
    'replace_markdown',
    'role',
    'status'
  ])
  expect(NATIVE_RISK.mcp__argus__update_finding).toEqual({ action: 'allow', risk: 'LOW' })
})

it('promotes a hypothesis, sets role and cause, appends evidence, and names the id in the result', async () => {
  const h = handlersFor(sessionFor())
  const root = idOf(await h.append_finding({ title: 'Root', markdown: 'b' }))
  const id = idOf(await h.append_finding({ title: 'Hyp', markdown: 'first', status: 'hypothesis' }))
  const out = await h.update_finding({
    finding_id: id,
    status: 'confirmed',
    role: 'symptom',
    caused_by: root,
    append_markdown: 'Seen at [evidence/log.txt:4].'
  })
  expect(out).toBe(`finding #${id} updated`)
  const row = listFindings(db, home, 'CASE-A').find((f) => f.id === id)!
  expect(row.status).toBe('confirmed')
  expect(row.role).toBe('symptom')
  expect(row.roleSource).toBe('agent')
  expect(row.causedBy).toBe(root)
  expect(row.body).toContain('### Update ')
  expect(row.body).toContain('Seen at [evidence/log.txt:4].')
  expect(emitFindingUpdated).toHaveBeenCalledWith(id)
  // null detaches; null role clears.
  await h.update_finding({ finding_id: id, caused_by: null, role: null })
  expect(col(id, 'caused_by')).toBeNull()
  expect(col(id, 'role_source')).toBeNull()
})

it('words every refusal and writes nothing', async () => {
  const h = handlersFor(sessionFor())
  const a = idOf(await h.append_finding({ title: 'A', markdown: 'b' }))
  const b = idOf(await h.append_finding({ title: 'B', markdown: 'b', caused_by: a }))
  await expect(h.update_finding({ finding_id: a })).rejects.toThrow(
    TOOL_FEEDBACK['update_finding.empty'].text
  )
  await expect(h.update_finding({ finding_id: a, caused_by: a })).rejects.toThrow(
    TOOL_FEEDBACK['finding.self-cause'].text
  )
  await expect(h.update_finding({ finding_id: a, caused_by: b })).rejects.toThrow(
    TOOL_FEEDBACK['finding.cycle'].text.replace('{id}', String(b))
  )
  await expect(h.update_finding({ finding_id: a, caused_by: 4242 })).rejects.toThrow(/unknown/i)
  const reviewOnly = idOf(
    await handlersFor(sessionFor('review')).append_finding({ title: 'r', markdown: 'b' })
  )
  await expect(h.update_finding({ finding_id: reviewOnly, status: 'hypothesis' })).rejects.toThrow(
    /unknown/i
  )
  db.prepare(`UPDATE findings SET review_state = 'accepted' WHERE id = ?`).run(a)
  await expect(h.update_finding({ finding_id: a, status: 'hypothesis' })).rejects.toThrow(
    TOOL_FEEDBACK['update_finding.accepted-locked'].text.replace('{id}', String(a))
  )
  db.prepare(
    `UPDATE findings SET review_state = 'pending', role = 'contributing', role_source = 'rca' WHERE id = ?`
  ).run(a)
  await expect(h.update_finding({ finding_id: a, role: 'symptom' })).rejects.toThrow(
    TOOL_FEEDBACK['update_finding.rca-frozen'].text.replace('{id}', String(a))
  )
  await h.update_finding({ finding_id: b, role: 'root-cause' })
  const c = idOf(await h.append_finding({ title: 'C', markdown: 'b' }))
  await expect(h.update_finding({ finding_id: c, role: 'root-cause' })).rejects.toThrow(
    TOOL_FEEDBACK['finding.second-root'].text.replace(/\{existing\}/g, String(b))
  )
  expect(col(a, 'caused_by')).toBeNull()
  expect(col(a, 'role')).toBe('contributing')
  expect(col(c, 'role')).toBeNull()
  expect(emitFindingUpdated).toHaveBeenCalledTimes(1) // only the successful b update
})

it('list_findings renders the investigation chain as sections with depth, status and review tag', async () => {
  const h = handlersFor(sessionFor())
  const root = idOf(
    await h.append_finding({ title: 'tilesVersion blocked', markdown: 'b', role: 'root-cause' })
  )
  const mid = idOf(
    await h.append_finding({
      title: 'Install rejected',
      markdown: 'b',
      role: 'contributing',
      caused_by: root
    })
  )
  const leaf = idOf(
    await h.append_finding({
      title: 'NoRoute offline',
      markdown: 'b',
      role: 'symptom',
      caused_by: mid
    })
  )
  const hyp = idOf(
    await h.append_finding({ title: 'Fallback never tried', markdown: 'b', status: 'hypothesis' })
  )
  const out1 = await h.append_finding({ title: 'Wrong idea', markdown: 'b' })
  await h.retract_finding({ finding_id: idOf(out1), reason: 'log was from the old build' })
  const out = await h.list_findings({})
  expect(out).toBe(
    [
      FINDING_TREE_HEADINGS['list_findings.root-cause'].text,
      `#${root} · confirmed · pending · root-cause · tilesVersion blocked`,
      `  ↳ #${mid} · confirmed · pending · contributing · Install rejected`,
      `    ↳ #${leaf} · confirmed · pending · symptom · NoRoute offline`,
      '',
      FINDING_TREE_HEADINGS['list_findings.unexplained'].text,
      `#${hyp} · hypothesis · pending · no role · Fallback never tried`,
      '',
      FINDING_TREE_HEADINGS['list_findings.ruled-out'].text,
      `#${idOf(out1)} · confirmed · rejected · retracted by agent: log was from the old build · no role · Wrong idea`
    ].join('\n')
  )
  fs.rmSync(path.join(caseDir(home, 'CASE-A'), 'findings.md')) // bodies are not part of the listing
  expect(await h.list_findings({})).toContain(`#${root} ·`)
})

it('list_findings keeps the flat line for a review session', async () => {
  const h = handlersFor(sessionFor('review'))
  const id = idOf(
    await h.append_finding({
      title: 'Inverted guard',
      markdown: 'See [repo/a.ts:4].',
      layer: 'correctness',
      severity: 'major'
    })
  )
  expect(await h.list_findings({})).toBe(
    `#${id} · pending · major/correctness · repo/a.ts:4 · Inverted guard`
  )
})

it('a review session may append evidence to its own finding but not set status, role or cause', async () => {
  const h = handlersFor(sessionFor('review'))
  const a = idOf(await h.append_finding({ title: 'Unchecked null', markdown: 'b' }))
  const b = idOf(await h.append_finding({ title: 'Missing retry', markdown: 'b' }))
  const refusal = TOOL_FEEDBACK['update_finding.review-mode'].text.replace('{id}', String(a))
  for (const patch of [{ role: 'root-cause' }, { status: 'hypothesis' }, { caused_by: b }]) {
    await expect(h.update_finding({ finding_id: a, ...patch })).rejects.toThrow(refusal)
  }
  expect(col(a, 'role')).toBeNull()
  expect(col(a, 'status')).toBeNull()
  expect(col(a, 'caused_by')).toBeNull()
  expect(emitFindingUpdated).not.toHaveBeenCalled()
  expect(
    await h.update_finding({ finding_id: a, append_markdown: 'Also on the error path.' })
  ).toBe(`finding #${a} updated`)
  expect(emitFindingUpdated).toHaveBeenCalledWith(a)
  // The description names every role the schema accepts, and says the chain is investigation-only.
  const spec = NATIVE_TOOL_SPECS.find((s) => s.name === 'update_finding')!
  expect(spec.description).toContain('ruled-out | duplicate; null clears')
  expect(spec.description).toContain('investigation sessions only')
})
it('names the accept in its result when a human had accepted the finding', async () => {
  const h = handlersFor(sessionFor())
  const id = idOf(await h.append_finding({ title: 'Accepted', markdown: 'b' }))
  reviewFinding(db, id, 'accepted')
  expect(await h.update_finding({ finding_id: id, append_markdown: 'more' })).toBe(
    `finding #${id} updated — a human had accepted it; their accept stands and only the cause or evidence changed`
  )
})
