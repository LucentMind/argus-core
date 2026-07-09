import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { openDb } from '../../db'
import { createCase } from '../../caseService'
import { AgentService } from '../registry'
import { AsyncQueue } from '../asyncQueue'
import type { CreateQueryFn } from '../session'
import type { AgentEvent } from '../../../../shared/agent-events'
import type { DatabaseSync } from 'node:sqlite'

let tmp: string, argusHome: string, db: DatabaseSync, events: AgentEvent[]

function fakeCreateQuery(): { createQuery: CreateQueryFn; queues: AsyncQueue<unknown>[] } {
  const queues: AsyncQueue<unknown>[] = []
  const createQuery: CreateQueryFn = () => {
    const q = new AsyncQueue<unknown>()
    queues.push(q)
    return Object.assign(
      { [Symbol.asyncIterator]: () => q[Symbol.asyncIterator]() },
      { interrupt: async () => q.end() }
    )
  }
  return { createQuery, queues }
}

beforeEach(() => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'argus-reg-'))
  argusHome = path.join(tmp, 'home')
  db = openDb(path.join(argusHome, 'argus.db'))
  events = []
  for (const slug of ['NAV-1', 'NAV-2', 'NAV-3', 'NAV-4']) {
    createCase(db, argusHome, { slug, title: slug })
  }
})

afterEach(() => {
  db.close()
  fs.rmSync(tmp, { recursive: true, force: true })
})

describe('AgentService', () => {
  it('keeps concurrent sessions per case and routes events with the right caseSlug', async () => {
    const { createQuery } = fakeCreateQuery()
    const svc = new AgentService({
      db,
      argusHome,
      skillsRoots: [],
      onEvent: (e) => events.push(e),
      createQuery
    })
    await svc.send('NAV-1', 'hello 1')
    await svc.send('NAV-2', 'hello 2')
    expect(svc.states()).toHaveLength(2)
    const slugs = events.filter((e) => e.type === 'turn.started').map((e) => e.caseSlug)
    expect(slugs.sort()).toEqual(['NAV-1', 'NAV-2'])
    await svc.stopAll()
  })

  it('reaps the least-recently-used idle session beyond maxSessions', async () => {
    const { createQuery, queues } = fakeCreateQuery()
    const svc = new AgentService({
      db,
      argusHome,
      skillsRoots: [],
      onEvent: (e) => events.push(e),
      createQuery,
      maxSessions: 2
    })
    await svc.send('NAV-1', 'a')
    // complete NAV-1's turn so it is idle
    queues[0].push({
      type: 'result',
      subtype: 'success',
      session_id: '11111111-1111-4111-8111-111111111111',
      usage: { input_tokens: 1, output_tokens: 1 },
      total_cost_usd: 0,
      duration_ms: 1,
      is_error: false
    })
    await new Promise((r) => setTimeout(r, 10))
    await svc.send('NAV-2', 'b')
    await svc.send('NAV-3', 'c')
    const states = svc.states()
    expect(states).toHaveLength(2)
    expect(states.map((s) => s.caseSlug)).not.toContain('NAV-1')
    expect(events.some((e) => e.type === 'session.exited' && e.caseSlug === 'NAV-1')).toBe(true)
    await svc.stopAll()
  })

  it('a reaped case restarts with its resume cursor', async () => {
    const { createQuery, queues } = fakeCreateQuery()
    const svc = new AgentService({
      db,
      argusHome,
      skillsRoots: [],
      onEvent: (e) => events.push(e),
      createQuery,
      maxSessions: 1
    })
    await svc.send('NAV-1', 'a')
    queues[0].push({
      type: 'system',
      subtype: 'init',
      session_id: '22222222-2222-4222-8222-222222222222',
      model: 'm'
    })
    await new Promise((r) => setTimeout(r, 10))
    await svc.stopAll()
    // new service instance = app restart
    const svc2 = new AgentService({
      db,
      argusHome,
      skillsRoots: [],
      onEvent: () => undefined,
      createQuery
    })
    await svc2.send('NAV-1', 'b')
    const sess = db.prepare(`SELECT sdk_session_id FROM sessions`).get() as {
      sdk_session_id: string
    }
    expect(sess.sdk_session_id).toBe('22222222-2222-4222-8222-222222222222')
    await svc2.stopAll()
  })

  it('reads maxSessions live from agentSettings and passes instance config to sessions', async () => {
    const captured: Record<string, unknown>[] = []
    const queues: AsyncQueue<unknown>[] = []
    const createQuery: CreateQueryFn = (args) => {
      captured.push(args.options as Record<string, unknown>)
      const q = new AsyncQueue<unknown>()
      queues.push(q)
      return Object.assign(
        { [Symbol.asyncIterator]: () => q[Symbol.asyncIterator]() },
        {
          interrupt: async () => q.end()
        }
      )
    }
    const endTurn = async (i: number): Promise<void> => {
      // reap only targets idle sessions (activeTurn === false) — finish the turn first
      queues[i].push({ type: 'result', is_error: false })
      await new Promise((r) => setTimeout(r, 10))
    }
    let maxSessions = 1
    const svc = new AgentService({
      db,
      argusHome,
      skillsRoots: [],
      onEvent: () => {},
      createQuery,
      agentSettings: () => ({
        activeInstanceId: 'claude-default',
        maxSessions,
        probeTimeoutMs: 10000,
        defaultPermissionMode: 'acceptEdits' as const,
        personaAppend: 'brief.',
        providerInstances: {
          'claude-default': {
            driver: 'claude-agent-sdk',
            enabled: true,
            config: { model: 'claude-opus-4-8' }
          }
        }
      })
    })
    createCase(db, argusHome, { slug: 'C-1', title: 'a' })
    createCase(db, argusHome, { slug: 'C-2', title: 'b' })
    await svc.send('C-1', 'hi')
    expect((captured[0].systemPrompt as { append: string }).append).toContain('brief.')
    expect(captured[0].model).toBe('claude-opus-4-8')
    expect(captured[0].permissionMode).toBe('acceptEdits')
    await endTurn(0)
    await svc.send('C-2', 'hi') // maxSessions 1 → idle C-1 reaped
    expect(
      svc
        .states()
        .filter((s) => s.state === 'running')
        .map((s) => s.caseSlug)
    ).toEqual(['C-2'])
    await endTurn(1)
    maxSessions = 3
    await svc.send('C-1', 'hi') // live read: no reap now
    expect(svc.states().filter((s) => s.state === 'running')).toHaveLength(2)
    await svc.stopAll()
  })
})
