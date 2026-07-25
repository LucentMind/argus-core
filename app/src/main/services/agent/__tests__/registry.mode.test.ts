import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { openDb } from '../../db'
import { createCase } from '../../caseService'
import { AgentService } from '../registry'
import { createSession } from '../sessionStore'
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

beforeEach(() => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'argus-reg-mode-'))
  argusHome = path.join(tmp, 'home')
  db = openDb(path.join(argusHome, 'argus.db'))
  events = []
  createCase(db, argusHome, { slug: 'NAV-1', title: 'NAV-1' })
})

afterEach(() => {
  db.close()
  fs.rmSync(tmp, { recursive: true, force: true })
})

describe('AgentService — mode participates in the live-session rebuild decision', () => {
  it('rebuilds a live idle session when its mode changes, applying the new mode persona', async () => {
    // Mirrors the model-rebuild regression test above: mode, like model and the
    // mcpServers map, is frozen at query() construction. Changing it under a live
    // session must force a rebuild or the new mode's persona/skills never take effect.
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
    const s = createSession(db, 'NAV-1', { driverKind: 'claude-agent-sdk', mode: 'investigation' })
    await svc.send('NAV-1', s.id, 'first')
    queues[0].push({ type: 'result', is_error: false }) // finish the turn → idle
    await new Promise((r) => setTimeout(r, 10))
    expect(optionsLog).toHaveLength(1)
    expect((optionsLog[0].systemPrompt as { append: string }).append).not.toContain(
      'CODE REVIEW mode'
    )

    // A session's mode is immutable through the app's own API (setSessionMode was
    // removed — Plan 1b makes mode a case-level axis, sessions just bind to it at
    // creation). AgentService's rebuild-on-mode-change guard must still hold for
    // whatever row is actually in the DB, so mutate it directly here, same as
    // sessionMode.test.ts's "direct DB edit / version downgrade" case.
    db.prepare(`UPDATE sessions SET mode = ? WHERE id = ?`).run('review', s.id)
    await svc.send('NAV-1', s.id, 'second')

    // must NOT be the stale cached session answering under the old persona
    expect(
      events.some((e) => e.type === 'session.exited' && e.payload.reason === 'reconfigured')
    ).toBe(true)
    expect(optionsLog).toHaveLength(2)
    expect((optionsLog[1].systemPrompt as { append: string }).append).toContain('CODE REVIEW mode')
    expect(svc.states()).toHaveLength(1) // rebuilt, not leaked
    await svc.stopAll()
  })

  it('does not rebuild when the pinned mode is unchanged', async () => {
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
    const s = createSession(db, 'NAV-1', { driverKind: 'claude-agent-sdk', mode: 'review' })
    await svc.send('NAV-1', s.id, 'first')
    queues[0].push({ type: 'result', is_error: false })
    await new Promise((r) => setTimeout(r, 10))
    await svc.send('NAV-1', s.id, 'second')
    expect(optionsLog).toHaveLength(1)
    expect(events.some((e) => e.type === 'session.exited')).toBe(false)
    await svc.stopAll()
  })

  it('never tears down a mid-turn session even when the mode was re-pinned', async () => {
    const { createQuery, optionsLog } = fakeCreateQuery()
    const svc = new AgentService({
      db,
      argusHome,
      detection,
      skillsRoots: [],
      agentAccess: () => defaultAgentAccess(),
      onEvent: (e) => events.push(e),
      createQuery
    })
    const s = createSession(db, 'NAV-1', { driverKind: 'claude-agent-sdk', mode: 'investigation' })
    await svc.send('NAV-1', s.id, 'first') // turn still in flight
    db.prepare(`UPDATE sessions SET mode = ? WHERE id = ?`).run('review', s.id)
    await svc.send('NAV-1', s.id, 'second')
    expect(optionsLog).toHaveLength(1) // rebuild deferred to the next idle send
    expect(events.some((e) => e.type === 'session.exited')).toBe(false)
    await svc.stopAll()
  })
})
