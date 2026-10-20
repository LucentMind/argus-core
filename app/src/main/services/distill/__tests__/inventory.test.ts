import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { describe, it, expect, beforeEach } from 'vitest'
import type { DatabaseSync } from 'node:sqlite'
import { openDb } from '../../db'
import { createCase } from '../../caseService'
import { buildAssetInventory } from '../inventory'
import { USAGE_PREDICATES } from '../../observability/usagePredicates'

let home: string
let db: DatabaseSync
let caseId: number
beforeEach(() => {
  home = fs.mkdtempSync(path.join(os.tmpdir(), 'argus-inv-'))
  db = openDb(path.join(home, 'argus.db'))
  caseId = createCase(db, home, { slug: 'c1', title: 'T' }).id
  db.prepare(
    `INSERT INTO sessions (id, case_id, created_at, updated_at) VALUES (1, ?, 'x', 'x'), (2, ?, 'x', 'x')`
  ).run(caseId, caseId)
})
function call(
  tool: string,
  detail: string | null,
  sessionId: number,
  at: string,
  decision = 'auto',
  turnId: number | null = null
): void {
  db.prepare(
    `INSERT INTO tool_calls (case_id, session_id, turn_id, tool, args_hash, detail, risk, decision, created_at)
     VALUES (?, ?, ?, ?, 'h', ?, 'LOW', ?, ?)`
  ).run(caseId, sessionId, turnId, tool, detail, decision, at)
}
const tiers = {
  skill: new Map<string, string | null>([['diag', 'user']]),
  reference: new Map<string, string | null>([['nav/limits.md', null]])
}

describe('buildAssetInventory', () => {
  it('collects skills, memories and reference reads with callCount, firstSeen and tier', () => {
    call('Skill', 'diag', 2, '2026-10-02T00:00:00Z', 'auto', 9)
    call('Skill', 'diag', 1, '2026-10-01T00:00:00Z', 'auto', 4)
    call('mcp__argus__read_memory', 'flaky-tests', 1, '2026-10-01T00:00:01Z')
    call('Read', 'ref:nav/limits.md', 1, '2026-10-01T00:00:02Z')
    call('Read', null, 1, '2026-10-01T00:00:03Z')
    const inv = buildAssetInventory(db, caseId, tiers)
    expect(inv).toEqual([
      {
        kind: 'skill',
        name: 'diag',
        tier: 'user',
        callCount: 2,
        firstSeen: { sessionId: 1, turnId: 4 }
      },
      {
        kind: 'reference',
        name: 'nav/limits.md',
        tier: null,
        callCount: 1,
        firstSeen: { sessionId: 1, turnId: null }
      },
      {
        kind: 'memory',
        name: 'flaky-tests',
        tier: null,
        callCount: 1,
        firstSeen: { sessionId: 1, turnId: null }
      }
    ])
  })
  it('skips an empty-named asset: a bare `ref:` detail or an empty skill/memory detail (C4)', () => {
    call('Read', 'ref:', 1, '2026-10-01T00:00:00Z')
    call('Skill', '', 1, '2026-10-01T00:00:01Z')
    call('mcp__argus__read_memory', '', 1, '2026-10-01T00:00:02Z')
    call('Skill', 'diag', 1, '2026-10-01T00:00:03Z')
    expect(buildAssetInventory(db, caseId, tiers).map((a) => `${a.kind}/${a.name}`)).toEqual([
      'skill/diag'
    ])
  })
  it('excludes denied/cancelled calls and other cases; unknown skill tier is null', () => {
    call('Skill', 'diag', 1, '2026-10-01T00:00:00Z', 'denied')
    call('Skill', 'other', 1, '2026-10-01T00:00:00Z')
    const otherCase = createCase(db, home, { slug: 'c2', title: 'T' }).id
    db.prepare(
      `INSERT INTO sessions (id, case_id, created_at, updated_at) VALUES (3, ?, 'x', 'x')`
    ).run(otherCase)
    db.prepare(
      `INSERT INTO tool_calls (case_id, session_id, tool, args_hash, detail, risk, decision, created_at) VALUES (?, 3, 'Skill', 'h', 'foreign', 'LOW', 'auto', 'x')`
    ).run(otherCase)
    expect(buildAssetInventory(db, caseId, tiers)).toEqual([
      {
        kind: 'skill',
        name: 'other',
        tier: null,
        callCount: 1,
        firstSeen: { sessionId: 1, turnId: null }
      }
    ])
  })
  it('sorts by callCount desc then kind order skill/reference/memory then name', () => {
    call('mcp__argus__read_memory', 'a', 1, 'x')
    call('mcp__argus__read_memory', 'a', 1, 'x')
    call('Skill', 'z', 1, 'x')
    call('Skill', 'b', 1, 'x')
    expect(buildAssetInventory(db, caseId, tiers).map((e) => `${e.kind}/${e.name}`)).toEqual([
      'memory/a',
      'skill/b',
      'skill/z'
    ])
  })
  it('uses the same SQL predicates usageStats uses (two representations of one fact)', () => {
    expect(USAGE_PREDICATES).toEqual({
      skill: "tool = 'Skill'",
      memory: "tool = 'mcp__argus__read_memory'",
      reference: "detail LIKE 'ref:%'"
    })
  })
})
