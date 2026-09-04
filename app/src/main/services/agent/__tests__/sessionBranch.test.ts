import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import type { DatabaseSync } from 'node:sqlite'
import { openDb } from '../../db'
import { createCase } from '../../caseService'
import { caseDir } from '../../paths'
import { readSessionEvents } from '../mirror'
import { rewindPreview, rewindSession, forkCaseSession, type BranchDeps } from '../sessionBranch'
import type { AgentDriver } from '../driver'
import type { AgentEvent } from '../../../../shared/agent-events'

const SLUG = 'SB-1'
const now = '2026-09-04T00:00:00Z'
let tmp: string, db: DatabaseSync, caseId: number, sessionId: number
let turns: number[]

function nativeDriver(over: Partial<AgentDriver> = {}): AgentDriver {
  return {
    kind: 'claude-agent-sdk',
    toolTaxonomy: {
      entries: {},
      fallback: () => ({ action: 'allow', risk: 'LOW' })
    } as never,
    capabilities: {
      permissionModes: ['default'],
      editableApprovals: true,
      costReporting: true,
      headlessOneShot: false,
      systemPromptTransport: 'systemPrompt.append',
      subagents: 'configurable',
      branching: 'native'
    },
    authFixHint: '',
    createSession: () => {
      throw new Error('unused')
    },
    probeAuth: async () => ({ ok: true }) as never,
    forkAt: vi.fn(async () => 'fork-cursor'),
    rewindTo: vi.fn(async () => 'rewound-cursor'),
    previewRewind: vi.fn(async () => ({ restored: ['note.txt'], skipped: 0 })),
    ...over
  }
}
function digestDriver(): AgentDriver {
  const d = nativeDriver()
  delete (d as Partial<AgentDriver>).forkAt
  delete (d as Partial<AgentDriver>).rewindTo
  delete (d as Partial<AgentDriver>).previewRewind
  return { ...d, kind: 'codex', capabilities: { ...d.capabilities, branching: 'digest' } }
}
function deps(driver: AgentDriver, over: Partial<BranchDeps> = {}): BranchDeps {
  return {
    db,
    argusHome: tmp,
    driverFor: () => driver,
    cliPathFor: () => undefined,
    isTurnActive: () => false,
    evictLive: vi.fn(async () => undefined),
    emitFindingUpdated: vi.fn(),
    sessionsChanged: vi.fn(),
    now: () => now,
    ...over
  }
}
function seed(): void {
  sessionId = Number(
    db
      .prepare(
        `INSERT INTO sessions (case_id, driver_cursor, driver_kind, title, turn_count, created_at, updated_at)
     VALUES (?, 'cur-0', 'claude-agent-sdk', 'parent', 3, ?, ?)`
      )
      .run(caseId, now, now).lastInsertRowid
  )
  turns = [1, 2, 3].map((i) =>
    Number(
      db
        .prepare(
          `INSERT INTO turns (case_id, session_id, turn_index, status, created_at, provider_anchor_id)
     VALUES (?, ?, ?, 'success', ?, ?)`
        )
        .run(caseId, sessionId, i, now, `a-${i}`).lastInsertRowid
    )
  )
  const ev = (turnId: number, type: string, payload: unknown): AgentEvent =>
    ({
      eventId: `${turnId}${type}`,
      caseId,
      caseSlug: SLUG,
      sessionId,
      turnId,
      ts: now,
      type,
      payload
    }) as AgentEvent
  const lines = turns.flatMap((t, i) => [
    ev(t, 'turn.started', { userText: `prompt ${i + 1}` }),
    ev(t, 'assistant.message', { text: `reply ${i + 1}` })
  ])
  const dir = path.join(caseDir(tmp, SLUG), 'sessions')
  fs.mkdirSync(dir, { recursive: true })
  fs.writeFileSync(
    path.join(dir, `${sessionId}.jsonl`),
    lines.map((e) => JSON.stringify(e)).join('\n') + '\n'
  )
  // findings: one pending in turn 2, one accepted in turn 3; a tool call in turn 3
  db.prepare(
    `INSERT INTO findings (case_id, session_id, turn_id, summary, review_state, created_at) VALUES (?, ?, ?, 'pending in t2', 'pending', ?)`
  ).run(caseId, sessionId, turns[1], now)
  db.prepare(
    `INSERT INTO findings (case_id, session_id, turn_id, summary, review_state, created_at) VALUES (?, ?, ?, 'accepted in t3', 'accepted', ?)`
  ).run(caseId, sessionId, turns[2], now)
  db.prepare(
    `INSERT INTO tool_calls (case_id, session_id, turn_id, tool, args_hash, risk, decision, created_at) VALUES (?, ?, ?, 'mcp__argus__post_review_comment', 'h', 'MEDIUM', 'allowed', ?)`
  ).run(caseId, sessionId, turns[2], now)
  db.prepare(
    `INSERT INTO tool_calls (case_id, session_id, turn_id, tool, args_hash, risk, decision, created_at) VALUES (?, ?, ?, 'Edit', 'h', 'MEDIUM', 'allowed', ?)`
  ).run(caseId, sessionId, turns[2], now)
}

beforeEach(() => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'argus-branch-'))
  db = openDb(path.join(tmp, 'argus.db'))
  caseId = createCase(db, tmp, { slug: SLUG, title: 's' }).id
  seed()
})
afterEach(() => {
  db.close()
  fs.rmSync(tmp, { recursive: true, force: true })
})

describe('rewindPreview', () => {
  it('lists the tail, the findings split, the external actions and native files', async () => {
    const p = await rewindPreview(deps(nativeDriver()), SLUG, sessionId, turns[0])
    expect(p.tail.map((t) => t.userText)).toEqual(['prompt 2', 'prompt 3'])
    expect(p.findingsToRetract.map((f) => f.summary)).toEqual(['pending in t2'])
    expect(p.findingsStaying).toEqual([
      expect.objectContaining({ summary: 'accepted in t3', reason: 'accepted' })
    ])
    expect(p.externalActions).toEqual([{ tool: 'mcp__argus__post_review_comment', count: 1 }])
    expect(p.files).toEqual({ kind: 'native', restored: ['note.txt'], skipped: 0 })
    expect(p.branching).toBe('native')
  })
  it('on a digest driver reports write counts and no file restore', async () => {
    const p = await rewindPreview(deps(digestDriver()), SLUG, sessionId, turns[0])
    expect(p.files).toEqual({ kind: 'counts', writes: [{ tool: 'Edit', count: 1 }] })
    expect(p.branching).toBe('digest')
  })
})

describe('rewindSession', () => {
  it('refuses while a turn is active, on an unknown anchor, on the last turn, and on a rewound anchor', async () => {
    await expect(
      rewindSession(deps(nativeDriver(), { isTurnActive: () => true }), SLUG, sessionId, turns[0])
    ).rejects.toThrow(/turn is still running/)
    await expect(rewindSession(deps(nativeDriver()), SLUG, sessionId, 999999)).rejects.toThrow(
      /not a turn of this session/
    )
    await expect(rewindSession(deps(nativeDriver()), SLUG, sessionId, turns[2])).rejects.toThrow(
      /already the last/
    )
    await rewindSession(deps(nativeDriver()), SLUG, sessionId, turns[0])
    await expect(rewindSession(deps(nativeDriver()), SLUG, sessionId, turns[1])).rejects.toThrow(
      /was rewound/
    )
  })
  it('evicts, asks the driver, marks the tail, retracts findings, swaps the cursor, broadcasts, returns the prompt', async () => {
    const drv = nativeDriver()
    const d = deps(drv)
    const r = await rewindSession(d, SLUG, sessionId, turns[0])
    expect(d.evictLive).toHaveBeenCalledWith(SLUG, sessionId)
    expect(drv.rewindTo).toHaveBeenCalledWith({
      cursor: 'cur-0',
      anchor: 'a-1',
      caseDir: caseDir(tmp, SLUG),
      cliPath: undefined
    })
    const rows = db
      .prepare(
        `SELECT id, status, rewound_to_turn_id, rewound_at FROM turns WHERE session_id = ? ORDER BY id`
      )
      .all(sessionId)
    expect(rows).toEqual([
      { id: turns[0], status: 'success', rewound_to_turn_id: null, rewound_at: null },
      { id: turns[1], status: 'rewound', rewound_to_turn_id: turns[0], rewound_at: now },
      { id: turns[2], status: 'rewound', rewound_to_turn_id: turns[0], rewound_at: now }
    ])
    expect(
      db
        .prepare(
          `SELECT review_state, review_actor, review_reason FROM findings WHERE summary = 'pending in t2'`
        )
        .get()
    ).toEqual({ review_state: 'rejected', review_actor: 'human', review_reason: 'rewound' })
    expect(
      db.prepare(`SELECT review_state FROM findings WHERE summary = 'accepted in t3'`).get()
    ).toEqual({ review_state: 'accepted' })
    expect(
      db
        .prepare(`SELECT driver_cursor, pre_rewind_cursor FROM sessions WHERE id = ?`)
        .get(sessionId)
    ).toEqual({ driver_cursor: 'rewound-cursor', pre_rewind_cursor: 'cur-0' })
    expect(d.emitFindingUpdated).toHaveBeenCalledTimes(1)
    expect(d.sessionsChanged).toHaveBeenCalledWith(SLUG)
    expect(r).toEqual({ composerText: 'prompt 2' })
  })
  it('on a digest driver nulls the cursor so the next send replays the digest', async () => {
    await rewindSession(deps(digestDriver()), SLUG, sessionId, turns[0])
    expect(db.prepare(`SELECT driver_cursor FROM sessions WHERE id = ?`).get(sessionId)).toEqual({
      driver_cursor: null
    })
  })
  it('writes nothing when the driver step throws', async () => {
    const drv = nativeDriver({
      rewindTo: vi.fn(async () => {
        throw new Error('sdk down')
      })
    })
    await expect(rewindSession(deps(drv), SLUG, sessionId, turns[0])).rejects.toThrow(/sdk down/)
    expect(db.prepare(`SELECT COUNT(*) AS n FROM turns WHERE status = 'rewound'`).get()).toEqual({
      n: 0
    })
    expect(db.prepare(`SELECT driver_cursor FROM sessions WHERE id = ?`).get(sessionId)).toEqual({
      driver_cursor: 'cur-0'
    })
  })
  it('refuses a concurrent branch operation on the same session', async () => {
    let release!: () => void
    const drv = nativeDriver({
      rewindTo: vi.fn(
        () =>
          new Promise<string>((res) => {
            release = () => res('x')
          })
      )
    })
    const first = rewindSession(deps(drv), SLUG, sessionId, turns[0])
    await new Promise((r) => setTimeout(r, 0))
    await expect(forkCaseSession(deps(drv), SLUG, sessionId, turns[0])).rejects.toThrow(
      /already being rewound or forked/
    )
    release()
    await first
  })
})

describe('forkCaseSession', () => {
  it('creates a sibling with lineage, copied turns (provider ids nulled), a copied mirror, and nothing else', async () => {
    const drv = nativeDriver()
    const d = deps(drv)
    const s = await forkCaseSession(d, SLUG, sessionId, turns[1])
    expect(drv.forkAt).toHaveBeenCalledWith({
      cursor: 'cur-0',
      anchor: 'a-2',
      caseDir: caseDir(tmp, SLUG),
      cliPath: undefined
    })
    expect(s.title).toBe('parent (fork)')
    expect(s.forkedFrom).toEqual({ sessionId, turnId: turns[1], inheritedTurns: 2 })
    expect(s.driverKind).toBe('claude-agent-sdk')
    const row = db
      .prepare(
        `SELECT driver_cursor, turn_count, forked_inherited_turns FROM sessions WHERE id = ?`
      )
      .get(s.id)
    expect(row).toEqual({ driver_cursor: 'fork-cursor', turn_count: 2, forked_inherited_turns: 2 })
    const copied = db
      .prepare(
        `SELECT turn_index, status, provider_anchor_id FROM turns WHERE session_id = ? ORDER BY id`
      )
      .all(s.id)
    expect(copied).toEqual([
      { turn_index: 1, status: 'success', provider_anchor_id: null },
      { turn_index: 2, status: 'success', provider_anchor_id: null }
    ])
    expect(
      db.prepare(`SELECT COUNT(*) AS n FROM tool_calls WHERE session_id = ?`).get(s.id)
    ).toEqual({ n: 0 })
    expect(db.prepare(`SELECT COUNT(*) AS n FROM findings WHERE session_id = ?`).get(s.id)).toEqual(
      {
        n: 0
      }
    )
    expect(
      db.prepare(`SELECT COUNT(*) AS n FROM messages_fts WHERE session_id = ?`).get(s.id)
    ).toEqual({ n: 0 })
    const ev = readSessionEvents(caseDir(tmp, SLUG), s.id)
    expect(
      ev
        .filter((e) => e.type === 'turn.started')
        .map((e) => (e.payload as { userText: string }).userText)
    ).toEqual(['prompt 1', 'prompt 2'])
    expect(new Set(ev.map((e) => e.sessionId))).toEqual(new Set([s.id]))
    expect(d.sessionsChanged).toHaveBeenCalledWith(SLUG)
  })
  it('skips rewound turns of the parent and allows forking from the last turn', async () => {
    await rewindSession(deps(nativeDriver()), SLUG, sessionId, turns[0])
    const s = await forkCaseSession(deps(nativeDriver()), SLUG, sessionId, turns[0])
    expect(s.forkedFrom?.inheritedTurns).toBe(1)
  })
})
