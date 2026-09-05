import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import type { DatabaseSync } from 'node:sqlite'
import { openDb } from '../services/db'
import { createCase } from '../services/caseService'
import { caseDir } from '../services/paths'
import { registerSessionBranchIpc } from '../ipc/sessionBranchIpc'
import type { BranchDeps } from '../services/agent/sessionBranch'
import type { AgentDriver } from '../services/agent/driver'
import type { AgentEvent } from '../../shared/agent-events'
import { makeEvent } from '../services/agent/events'
import { IPC } from '../../shared/ipc'

/**
 * `main/index.ts` imports `electron` at module scope and cannot be imported into a Vitest test
 * (see sessionRunOptionsIpc.test.ts / routinesIpc.test.ts for the same constraint) — but unlike
 * those, the three session-branch channels are NOT registered inline in index.ts: they're
 * registered through `registerSessionBranchIpc` (ipc/sessionBranchIpc.ts), a small DI-friendly
 * function modelled on services/update/updateIpc.ts's `registerUpdateIpc`. That means this file
 * can invoke the real handlers directly against a fake `handle`, a real sqlite db, and a real
 * (fake-driver) `BranchDeps` — actual behaviour, not source-text regexes.
 */
const SLUG = 'SB-1'
const now = '2026-09-05T00:00:00Z'
let tmp: string, db: DatabaseSync, caseId: number, sessionId: number
let turns: number[]

function nativeDriver(over: Partial<AgentDriver> = {}): AgentDriver {
  return {
    kind: 'claude-agent-sdk',
    toolTaxonomy: { entries: {}, fallback: () => ({ action: 'allow', risk: 'LOW' }) } as never,
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
    previewRewind: vi.fn(async () => ({ restored: [], skipped: 0 })),
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

interface FakeAgentService {
  states: () => { caseSlug: string; sessionId: number; state: string; activeTurn: boolean }[]
  stopSession: (caseSlug: string, sessionId: number) => Promise<void>
}

/**
 * Builds a `BranchDeps` the exact way index.ts's own `branchDeps()` does — `isTurnActive` reads
 * `agentService.states()`, `evictLive` calls `agentService.stopSession`, and the two broadcast
 * hooks push onto the same `broadcast()` sink index.ts uses for every other channel — so a test
 * against this harness is a test of the real wiring shape, not a simplified stand-in for it.
 */
function realBranchDeps(
  driver: AgentDriver,
  agentService: FakeAgentService,
  broadcast: (channel: string, payload: unknown) => void
): BranchDeps {
  return {
    db,
    argusHome: tmp,
    driverFor: () => driver,
    cliPathFor: () => undefined,
    isTurnActive: (caseSlug, sid) =>
      agentService
        .states()
        .some((s) => s.caseSlug === caseSlug && s.sessionId === sid && s.activeTurn),
    evictLive: (caseSlug, sid) => agentService.stopSession(caseSlug, sid),
    emitFindingUpdated: (ctx, findingId) =>
      broadcast(
        IPC.agentEventChannel,
        makeEvent({ ...ctx, turnId: null }, 'case.finding.updated', { findingId })
      ),
    sessionsChanged: (caseSlug) => broadcast(IPC.sessionsChanged, caseSlug),
    now: () => now
  }
}

interface Harness {
  handlers: Map<string, (...args: unknown[]) => unknown>
  broadcasts: { channel: string; payload: unknown }[]
}

function harness(driver: AgentDriver, agentService: FakeAgentService): Harness {
  const handlers = new Map<string, (...args: unknown[]) => unknown>()
  const broadcasts: { channel: string; payload: unknown }[] = []
  registerSessionBranchIpc({
    handle: (channel, fn) => void handlers.set(channel, fn),
    branchDeps: () =>
      realBranchDeps(driver, agentService, (channel, payload) =>
        broadcasts.push({ channel, payload })
      )
  })
  return { handlers, broadcasts }
}

function idleAgentService(): FakeAgentService {
  return { states: () => [], stopSession: vi.fn(async () => undefined) }
}
function activeTurnAgentService(): FakeAgentService {
  return {
    states: () => [{ caseSlug: SLUG, sessionId, state: 'running', activeTurn: true }],
    stopSession: vi.fn(async () => undefined)
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
  // one pending finding in turn 2 — the one a rewind past turn 1 must retract and broadcast
  db.prepare(
    `INSERT INTO findings (case_id, session_id, turn_id, summary, review_state, created_at) VALUES (?, ?, ?, 'pending in t2', 'pending', ?)`
  ).run(caseId, sessionId, turns[1], now)
}

beforeEach(() => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'argus-branch-ipc-'))
  db = openDb(path.join(tmp, 'argus.db'))
  caseId = createCase(db, tmp, { slug: SLUG, title: 's' }).id
  seed()
})
afterEach(() => {
  db.close()
  fs.rmSync(tmp, { recursive: true, force: true })
})

describe('registerSessionBranchIpc', () => {
  it('registers exactly the four request/response channels', () => {
    const { handlers } = harness(nativeDriver(), idleAgentService())
    expect([...handlers.keys()].sort()).toEqual(
      [
        IPC.sessionsRewindPreview,
        IPC.sessionsRewind,
        IPC.sessionsFork,
        IPC.sessionsBranchPreview
      ].sort()
    )
  })

  /** I3: the renderer must be able to ask MAIN what branching a fork at this anchor would get,
   *  rather than guessing from driver capabilities it can see but main does not decide on. */
  it('sessions:branch-preview answers native, and digest once the anchor loses its provider id', async () => {
    const { handlers } = harness(nativeDriver(), idleAgentService())
    expect(await handlers.get(IPC.sessionsBranchPreview)!(SLUG, sessionId, turns[1])).toEqual({
      branching: 'native'
    })
    db.prepare(`UPDATE turns SET provider_anchor_id = NULL WHERE id = ?`).run(turns[1])
    expect(await handlers.get(IPC.sessionsBranchPreview)!(SLUG, sessionId, turns[1])).toEqual({
      branching: 'digest'
    })
  })

  it('sessions:branch-preview validates its ids like the other three', () => {
    const { handlers } = harness(nativeDriver(), idleAgentService())
    expect(() => handlers.get(IPC.sessionsBranchPreview)!('not a slug!', sessionId, 1)).toThrow(
      /Invalid case slug/
    )
    expect(() => handlers.get(IPC.sessionsBranchPreview)!(SLUG, 1.5, 1)).toThrow(/Invalid id/)
  })

  it('sessions:rewind rejects with the preflight message when a turn is still active', async () => {
    const { handlers } = harness(nativeDriver(), activeTurnAgentService())
    await expect(handlers.get(IPC.sessionsRewind)!(SLUG, sessionId, turns[0])).rejects.toThrow(
      /turn is still running/
    )
  })

  it('sessions:rewind-preview rejects with the same preflight message when a turn is active', async () => {
    const { handlers } = harness(nativeDriver(), activeTurnAgentService())
    await expect(
      handlers.get(IPC.sessionsRewindPreview)!(SLUG, sessionId, turns[0])
    ).rejects.toThrow(/turn is still running/)
  })

  it('sessions:fork rejects with the same preflight message when a turn is active', async () => {
    const { handlers } = harness(nativeDriver(), activeTurnAgentService())
    await expect(handlers.get(IPC.sessionsFork)!(SLUG, sessionId, turns[0])).rejects.toThrow(
      /turn is still running/
    )
  })

  it(
    'on a digest driver, the happy path marks the tail rewound, retracts the pending finding, ' +
      'and broadcasts sessions:changed + agent:event(case.finding.updated)',
    async () => {
      const { handlers, broadcasts } = harness(digestDriver(), idleAgentService())
      const result = await handlers.get(IPC.sessionsRewind)!(SLUG, sessionId, turns[0])
      expect(result).toEqual({ composerText: 'prompt 2' })

      const rows = db
        .prepare(`SELECT id, status FROM turns WHERE session_id = ? ORDER BY id`)
        .all(sessionId) as { id: number; status: string }[]
      expect(rows).toEqual([
        { id: turns[0], status: 'success' },
        { id: turns[1], status: 'rewound' },
        { id: turns[2], status: 'rewound' }
      ])
      expect(
        db.prepare(`SELECT review_state FROM findings WHERE summary = 'pending in t2'`).get()
      ).toEqual({ review_state: 'rejected' })

      expect(broadcasts).toContainEqual({ channel: IPC.sessionsChanged, payload: SLUG })
      expect(broadcasts).toContainEqual(
        expect.objectContaining({
          channel: IPC.agentEventChannel,
          payload: expect.objectContaining({ type: 'case.finding.updated' })
        })
      )
    }
  )

  /** M4: the renderer tells main what the dialog the user actually confirmed said about files,
   *  because main no longer runs the dry run a second time (I4). */
  it('sessions:rewind passes { filesUnavailable } through, degrading the rewind to a fork', async () => {
    const drv = nativeDriver()
    const { handlers } = harness(drv, idleAgentService())
    await handlers.get(IPC.sessionsRewind)!(SLUG, sessionId, turns[0], { filesUnavailable: true })
    expect(drv.forkAt).toHaveBeenCalled()
    expect(drv.rewindTo).not.toHaveBeenCalled()
  })

  it('sessions:rewind without the options object still rewinds files', async () => {
    const drv = nativeDriver()
    const { handlers } = harness(drv, idleAgentService())
    await handlers.get(IPC.sessionsRewind)!(SLUG, sessionId, turns[0])
    expect(drv.rewindTo).toHaveBeenCalled()
    expect(drv.forkAt).not.toHaveBeenCalled()
  })

  it('sessions:rewind-preview reaches rewindPreview and reports the digest write counts', async () => {
    const { handlers } = harness(digestDriver(), idleAgentService())
    const preview = (await handlers.get(IPC.sessionsRewindPreview)!(SLUG, sessionId, turns[0])) as {
      branching: string
      tail: { userText: string }[]
    }
    expect(preview.branching).toBe('digest')
    expect(preview.tail.map((t) => t.userText)).toEqual(['prompt 2', 'prompt 3'])
  })

  it('sessions:fork reaches forkCaseSession and broadcasts sessions:changed', async () => {
    const { handlers, broadcasts } = harness(nativeDriver(), idleAgentService())
    const summary = (await handlers.get(IPC.sessionsFork)!(SLUG, sessionId, turns[1])) as {
      title: string
    }
    expect(summary.title).toBe('parent (fork)')
    expect(broadcasts).toContainEqual({ channel: IPC.sessionsChanged, payload: SLUG })
  })

  it('rejects a malformed case slug before ever touching BranchDeps', () => {
    // The guard throws SYNCHRONOUSLY (assertSlug runs before any await), matching index.ts's
    // own un-async ipcMain.handle callbacks — Electron wraps a sync throw into a rejected
    // invoke() for the renderer, but calling the handler directly here throws immediately.
    const { handlers } = harness(nativeDriver(), idleAgentService())
    expect(() => handlers.get(IPC.sessionsRewind)!('not a slug!', sessionId, turns[0])).toThrow(
      /Invalid case slug/
    )
  })

  it('rejects a non-integer session or anchor id', () => {
    const { handlers } = harness(nativeDriver(), idleAgentService())
    expect(() => handlers.get(IPC.sessionsRewind)!(SLUG, 1.5, turns[0])).toThrow(/Invalid id/)
    expect(() => handlers.get(IPC.sessionsRewind)!(SLUG, sessionId, NaN)).toThrow(/Invalid id/)
  })
})
