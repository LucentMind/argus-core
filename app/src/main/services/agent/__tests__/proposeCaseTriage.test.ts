import { describe, expect, it, beforeEach, afterEach } from 'vitest'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import type { DatabaseSync } from 'node:sqlite'
import { openDb } from '../../db'
import { createCase } from '../../caseService'
import { createDetection } from '../../packs/detection'
import { insertRoutineRun } from '../../routines/runs'
import { insertRunItem, getRunItem } from '../../routines/runItems'
import { argusToolHandlers, resolveToolSpecs, type NativeToolDeps } from '../nativeTools'

let tmp: string
let db: DatabaseSync

beforeEach(() => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'triage-tool-'))
  db = openDb(path.join(tmp, 'a.sqlite'))
  createCase(db, tmp, { slug: 'abc-1', title: 'ABC-1' })
})
afterEach(() => {
  db.close()
  fs.rmSync(tmp, { recursive: true, force: true })
})

const makeItem = (): number =>
  insertRunItem(db, insertRoutineRun(db, 'nightly', 'routine-nightly', 'scheduled'), 'ABC-1')

const tools = (
  currentRunItemId: () => number | null
): Record<string, (args: Record<string, unknown>) => Promise<string>> =>
  argusToolHandlers({
    db,
    argusHome: tmp,
    detection: createDetection(),
    caseId: 1,
    caseSlug: 'abc-1',
    sessionId: 1,
    emitFinding: () => {},
    currentRunItemId,
    githubWatermark: () => ({ enabled: false, text: '' })
  })

describe('propose_case_triage', () => {
  it('stores the proposal on the item row', async () => {
    const itemId = makeItem()
    await tools(() => itemId).propose_case_triage({
      title: 'Crash on empty payload',
      tags: ['severity:high'],
      rationale: 'stack trace matches ABC-9'
    })
    expect(getRunItem(db, itemId)!.suggestion).toEqual({
      title: 'Crash on empty payload',
      tags: ['severity:high'],
      rationale: 'stack trace matches ABC-9'
    })
  })

  it('DOES NOT touch the case — that is the whole point of it being a suggestion', async () => {
    const itemId = makeItem()
    // Snapshot the ENTIRE row, not just title/tags: `cases` has id, slug, title, jira_key,
    // status, resolution, tags, origin, review_state, created_at, updated_at. Checking only two
    // columns would pass even if the handler started flipping status/resolution/review_state or
    // bumping updated_at — any of which would silently defeat "it's a suggestion until a human
    // accepts it". SELECT * so a future column addition is covered automatically too.
    const before = db.prepare(`SELECT * FROM cases WHERE slug = 'abc-1'`).get()
    await tools(() => itemId).propose_case_triage({
      title: 'Crash on empty payload',
      tags: ['severity:high'],
      rationale: 'because'
    })
    const after = db.prepare(`SELECT * FROM cases WHERE slug = 'abc-1'`).get()
    expect(after).toEqual(before)
  })

  it('refuses outside an item run rather than silently discarding the proposal', async () => {
    const res = await tools(() => null).propose_case_triage({ rationale: 'because' })
    expect(res).toMatch(/not processing an item/i)
    // Nothing written anywhere.
    const n = db.prepare(`SELECT COUNT(*) AS n FROM routine_run_items`).get() as { n: number }
    expect(n.n).toBe(0)
  })

  it('overwrites an earlier proposal for the same item, so the last word wins', async () => {
    const itemId = makeItem()
    const t = tools(() => itemId)
    await t.propose_case_triage({ title: 'first', rationale: 'a' })
    await t.propose_case_triage({ title: 'second', rationale: 'b' })
    expect(getRunItem(db, itemId)!.suggestion!.title).toBe('second')
  })
})

describe('propose_case_triage tool-list advertisement', () => {
  // Mirrors exactly how the two driver call sites decide the flag —
  // `drivers/claude/index.ts`'s createArgusMcpServer and `drivers/copilot/index.ts`'s
  // buildCopilotTools both compute `hasItemContext: deps.currentRunItemId != null` off the same
  // NativeToolDeps field. An ordinary interactive session (registry.ts) never sets
  // currentRunItemId at all, so this is the one signal that separates it from a routine-item
  // session.
  const baseDeps: Pick<
    NativeToolDeps,
    | 'db'
    | 'argusHome'
    | 'detection'
    | 'caseId'
    | 'caseSlug'
    | 'sessionId'
    | 'emitFinding'
    | 'githubWatermark'
  > = {
    db: undefined as unknown as NativeToolDeps['db'], // unused: resolveToolSpecs never touches deps.db
    argusHome: '',
    detection: undefined as unknown as NativeToolDeps['detection'],
    caseId: 1,
    caseSlug: 'abc-1',
    sessionId: 1,
    emitFinding: () => {},
    githubWatermark: () => ({ enabled: false, text: '' })
  }

  it('is NOT advertised to a session without an item context (ordinary case session)', () => {
    const deps: NativeToolDeps = { ...baseDeps } // no currentRunItemId at all
    const specs = resolveToolSpecs(undefined, { hasItemContext: deps.currentRunItemId != null })
    expect(specs.map((s) => s.name)).not.toContain('propose_case_triage')
  })

  it('IS advertised to a session with an item context (routine processing an item)', () => {
    const deps: NativeToolDeps = { ...baseDeps, currentRunItemId: () => 42 }
    const specs = resolveToolSpecs(undefined, { hasItemContext: deps.currentRunItemId != null })
    expect(specs.map((s) => s.name)).toContain('propose_case_triage')
  })

  it('IS advertised even when currentRunItemId is wired but returns null between items', () => {
    // The gate is on the SESSION being wired for item-processing (the thunk being populated),
    // not on the per-call return value — a routine session must still see the tool between
    // items; the handler's own runtime refusal (deps.currentRunItemId?.() ?? null) is what
    // covers that turn.
    const deps: NativeToolDeps = { ...baseDeps, currentRunItemId: () => null }
    const specs = resolveToolSpecs(undefined, { hasItemContext: deps.currentRunItemId != null })
    expect(specs.map((s) => s.name)).toContain('propose_case_triage')
  })

  it('every OTHER native tool stays advertised regardless of item context', () => {
    const without = resolveToolSpecs(undefined, { hasItemContext: false }).map((s) => s.name)
    const withCtx = resolveToolSpecs(undefined, { hasItemContext: true }).map((s) => s.name)
    expect(withCtx.filter((n) => n !== 'propose_case_triage').sort()).toEqual(without.sort())
  })
})
