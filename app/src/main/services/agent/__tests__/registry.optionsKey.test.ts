import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { openDb } from '../../db'
import { createCase } from '../../caseService'
import { AgentService } from '../registry'
import { createSession, setSessionRunOptions, setSessionPermissionMode } from '../sessionStore'
import { AsyncQueue } from '../asyncQueue'
import { defaultAgentAccess } from '../../../../shared/agentAccess'
import { createDetection } from '../../packs/detection'
import type { CreateQueryFn } from '../drivers/claude'
import type { AgentEvent } from '../../../../shared/agent-events'
import type { DatabaseSync } from 'node:sqlite'

let tmp: string, argusHome: string, db: DatabaseSync, events: AgentEvent[]
const detection = createDetection()

function fakeCreateQuery(): {
  createQuery: CreateQueryFn
  queues: AsyncQueue<unknown>[]
  optionsLog: Record<string, unknown>[]
} {
  const queues: AsyncQueue<unknown>[] = []
  const optionsLog: Record<string, unknown>[] = []
  const createQuery: CreateQueryFn = (args) => {
    optionsLog.push(args.options as Record<string, unknown>)
    const q = new AsyncQueue<unknown>()
    queues.push(q)
    return Object.assign(
      { [Symbol.asyncIterator]: () => q[Symbol.asyncIterator]() },
      { interrupt: async () => q.end() }
    )
  }
  return { createQuery, queues, optionsLog }
}

/** Reaches into AgentService's private session cache the same way session.test.ts reaches
 *  into CaseSession's private `deps` (line ~555) — there is no public accessor, and adding
 *  one just for a test would widen the class's surface for no production benefit. */
function liveSession(svc: AgentService, caseSlug: string, sessionId: number): unknown {
  return (svc as unknown as { sessions: Map<string, unknown> }).sessions.get(
    `${caseSlug}::${sessionId}`
  )
}

beforeEach(() => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'argus-reg-optkey-'))
  argusHome = path.join(tmp, 'home')
  db = openDb(path.join(argusHome, 'argus.db'))
  events = []
  createCase(db, argusHome, { slug: 'NAV-1', title: 'NAV-1' })
})

afterEach(() => {
  db.close()
  fs.rmSync(tmp, { recursive: true, force: true })
})

describe('AgentService — run options and permission mode participate in the live-session rebuild decision', () => {
  it('rebuilds a live idle session when its run_options change', async () => {
    const { createQuery, queues, optionsLog } = fakeCreateQuery()
    const svc = new AgentService({
      db,
      argusHome,
      detection,
      skillsRoots: [],
      agentAccess: () => defaultAgentAccess(),
      onEvent: (e) => events.push(e),
      createQuery
    })
    const s = createSession(db, 'NAV-1', { driverKind: 'claude-agent-sdk' })
    await svc.send('NAV-1', s.id, 'first')
    const first = liveSession(svc, 'NAV-1', s.id)
    queues[0].push({ type: 'result', is_error: false }) // finish the turn → idle
    await new Promise((r) => setTimeout(r, 10))
    expect(optionsLog).toHaveLength(1)

    expect(setSessionRunOptions(db, s.id, [{ id: 'effort', value: 'xhigh' }])).toBe(true)
    await svc.send('NAV-1', s.id, 'second')

    // must NOT be the stale cached session answering under the old options
    expect(
      events.some((e) => e.type === 'session.exited' && e.payload.reason === 'reconfigured')
    ).toBe(true)
    expect(optionsLog).toHaveLength(2)
    const second = liveSession(svc, 'NAV-1', s.id)
    expect(second).not.toBe(first)
    expect(svc.states()).toHaveLength(1) // rebuilt, not leaked
    await svc.stopAll()
  })

  it('rebuilds a live idle session when its permission_mode changes', async () => {
    const { createQuery, queues, optionsLog } = fakeCreateQuery()
    const svc = new AgentService({
      db,
      argusHome,
      detection,
      skillsRoots: [],
      agentAccess: () => defaultAgentAccess(),
      onEvent: (e) => events.push(e),
      createQuery
    })
    const s = createSession(db, 'NAV-1', { driverKind: 'claude-agent-sdk' })
    await svc.send('NAV-1', s.id, 'first')
    const first = liveSession(svc, 'NAV-1', s.id)
    queues[0].push({ type: 'result', is_error: false })
    await new Promise((r) => setTimeout(r, 10))
    expect(optionsLog).toHaveLength(1)

    expect(setSessionPermissionMode(db, s.id, 'acceptEdits')).toBe(true)
    await svc.send('NAV-1', s.id, 'second')

    expect(
      events.some((e) => e.type === 'session.exited' && e.payload.reason === 'reconfigured')
    ).toBe(true)
    expect(optionsLog).toHaveLength(2)
    const second = liveSession(svc, 'NAV-1', s.id)
    expect(second).not.toBe(first)
    expect(svc.states()).toHaveLength(1)
    await svc.stopAll()
  })

  it('does not rebuild — and returns the SAME cached instance — when nothing changed', async () => {
    const { createQuery, queues, optionsLog } = fakeCreateQuery()
    const svc = new AgentService({
      db,
      argusHome,
      detection,
      skillsRoots: [],
      agentAccess: () => defaultAgentAccess(),
      onEvent: (e) => events.push(e),
      createQuery
    })
    const s = createSession(db, 'NAV-1', { driverKind: 'claude-agent-sdk' })
    await svc.send('NAV-1', s.id, 'first')
    const first = liveSession(svc, 'NAV-1', s.id)
    queues[0].push({ type: 'result', is_error: false })
    await new Promise((r) => setTimeout(r, 10))

    await svc.send('NAV-1', s.id, 'second')

    expect(optionsLog).toHaveLength(1) // no second query() call — same query options reused
    expect(events.some((e) => e.type === 'session.exited')).toBe(false)
    const second = liveSession(svc, 'NAV-1', s.id)
    expect(second).toBe(first) // same instance — the key is stable, not thrashing on every send
    await svc.stopAll()
  })
})
