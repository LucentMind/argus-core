import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import type { DatabaseSync } from 'node:sqlite'
import { openDb } from '../../db'
import { createCase } from '../../caseService'
import { upsertCaseSummary } from '../../distill/summaries'
import { createDetection } from '../../packs/detection'
import { argusToolHandlers } from '../nativeTools'
import { classifyToolCall, CLAUDE_TOOL_TAXONOMY, type RiskContext } from '../risk'

let tmp: string
let argusHome: string
let db: DatabaseSync
const emitFinding = vi.fn()
const detection = createDetection()

function ctx(overrides: Partial<RiskContext> = {}): RiskContext {
  return {
    caseDir: '/home/u/Argus/cases/old',
    workspaceRoots: [],
    readonlyRoots: [],
    taxonomy: CLAUDE_TOOL_TAXONOMY,
    ...overrides
  }
}

beforeEach(() => {
  emitFinding.mockClear()
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'argus-sch-'))
  argusHome = path.join(tmp, 'home')
  db = openDb(path.join(argusHome, 'argus.db'))
  createCase(db, argusHome, { slug: 'old', title: 'DLT drift' })
  upsertCaseSummary(
    db,
    argusHome,
    'old',
    {
      signature: 'ECU reset drifts DLT timestamps',
      symptoms: 's',
      rootCause: 'r',
      fix: 'f',
      keywords: ['dlt']
    },
    'solved',
    '# s'
  )
})

afterEach(() => {
  db.close()
  fs.rmSync(tmp, { recursive: true, force: true })
})

describe('search_case_history', () => {
  it('returns matching summaries as text', async () => {
    const handlers = argusToolHandlers({
      db,
      argusHome,
      detection,
      caseId: 1,
      caseSlug: 'new-case',
      sessionId: 1,
      emitFinding,
      githubWatermark: () => ({ enabled: false, text: '' })
    })
    const text = String(await handlers.search_case_history({ query: 'DLT drift' }))
    expect(text).toContain('old')
    expect(text).toContain('ECU reset drifts DLT timestamps')
    expect(String(await handlers.search_case_history({ query: 'zzz-nomatch' }))).toContain(
      'No similar past cases'
    )
  })

  it('suffixes a solved case with whether a human accepted its root cause', async () => {
    const handlers = argusToolHandlers({
      db,
      argusHome,
      detection,
      caseId: 1,
      caseSlug: 'new-case',
      sessionId: 1,
      emitFinding,
      githubWatermark: () => ({ enabled: false, text: '' })
    })
    db.prepare(`UPDATE cases SET status = 'closed', resolution = 'solved' WHERE slug = 'old'`).run()
    const caseId = (db.prepare(`SELECT id FROM cases WHERE slug = 'old'`).get() as { id: number })
      .id
    db.prepare(
      `INSERT INTO findings (case_id, session_id, summary, review_state, created_at, role, role_source, status)
       VALUES (?, NULL, 'root', 'pending', 'x', 'root-cause', 'agent', 'confirmed')`
    ).run(caseId)
    expect(String(await handlers.search_case_history({ query: 'DLT' }))).toContain(
      '«old» [solved · root cause unconfirmed] ECU reset drifts DLT timestamps'
    )
    db.prepare(
      `UPDATE findings SET review_state = 'accepted', review_actor = 'human' WHERE case_id = ?`
    ).run(caseId)
    expect(String(await handlers.search_case_history({ query: 'DLT' }))).toContain(
      '«old» [solved · root cause accepted] ECU reset drifts DLT timestamps'
    )
  })

  it('is classified LOW/allow', () => {
    const v = classifyToolCall('mcp__argus__search_case_history', {}, ctx())
    expect(v).toMatchObject({ action: 'allow', risk: 'LOW' })
  })
})
