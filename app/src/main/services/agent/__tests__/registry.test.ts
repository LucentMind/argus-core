import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { openDb } from '../../db'
import { createCase } from '../../caseService'
import { AgentService } from '../registry'
import { createSession, deleteSession } from '../sessionStore'
import { AsyncQueue } from '../asyncQueue'
import { defaultAgentAccess, agentAccessSchema } from '../../../../shared/agentAccess'
import { createDetection } from '../../packs/detection'
import { SessionMirror } from '../mirror'
import { caseDir } from '../../paths'
import type { CreateQueryFn } from '../session'
import type { AgentEvent } from '../../../../shared/agent-events'
import type { DatabaseSync } from 'node:sqlite'

let tmp: string, argusHome: string, db: DatabaseSync, events: AgentEvent[]
const detection = createDetection()

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
  it('runs two live sessions of the same case independently', async () => {
    const { createQuery } = fakeCreateQuery()
    const svc = new AgentService({
      db,
      argusHome,
      detection,
      skillsRoots: [],
      agentAccess: () => defaultAgentAccess(),
      onEvent: (e) => events.push(e),
      createQuery
    })
    const a = createSession(db, 'NAV-1')
    const b = createSession(db, 'NAV-1')
    await svc.send('NAV-1', a.id, 'hello a')
    await svc.send('NAV-1', b.id, 'hello b')
    const states = svc.states()
    expect(states.filter((s) => s.caseSlug === 'NAV-1')).toHaveLength(2)
    expect(new Set(states.map((s) => s.sessionId))).toEqual(new Set([a.id, b.id]))
    await svc.stopAll()
  })

  it('rejects a bad sessionId without reaping any live session', async () => {
    const { createQuery, queues } = fakeCreateQuery()
    const svc = new AgentService({
      db,
      argusHome,
      detection,
      skillsRoots: [],
      agentAccess: () => defaultAgentAccess(),
      onEvent: (e) => events.push(e),
      createQuery,
      maxSessions: 2
    })
    const s1 = createSession(db, 'NAV-1')
    const s2 = createSession(db, 'NAV-2')
    await svc.send('NAV-1', s1.id, 'a')
    await svc.send('NAV-2', s2.id, 'b')
    // finish both turns so the sessions are idle — eligible for LRU reaping
    for (const q of queues) q.push({ type: 'result', is_error: false })
    await new Promise((r) => setTimeout(r, 10))

    // nonexistent session id: must throw before any eviction happens
    await expect(svc.send('NAV-1', 999999, 'x')).rejects.toThrow(
      'Unknown session 999999 for case NAV-1'
    )
    // foreign session id (belongs to NAV-2): same contract
    await expect(svc.send('NAV-1', s2.id, 'x')).rejects.toThrow(
      `Unknown session ${s2.id} for case NAV-1`
    )

    const states = svc.states()
    expect(states).toHaveLength(2)
    expect(states.every((s) => s.state === 'running')).toBe(true)
    expect(new Set(states.map((s) => s.sessionId))).toEqual(new Set([s1.id, s2.id]))
    expect(events.some((e) => e.type === 'session.exited')).toBe(false)
    await svc.stopAll()
  })

  it('keeps concurrent sessions per case and routes events with the right caseSlug', async () => {
    const { createQuery } = fakeCreateQuery()
    const svc = new AgentService({
      db,
      argusHome,
      detection,
      skillsRoots: [],
      agentAccess: () => defaultAgentAccess(),
      onEvent: (e) => events.push(e),
      createQuery
    })
    const s1 = createSession(db, 'NAV-1')
    const s2 = createSession(db, 'NAV-2')
    await svc.send('NAV-1', s1.id, 'hello 1')
    await svc.send('NAV-2', s2.id, 'hello 2')
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
      detection,
      skillsRoots: [],
      agentAccess: () => defaultAgentAccess(),
      onEvent: (e) => events.push(e),
      createQuery,
      maxSessions: 2
    })
    const s1 = createSession(db, 'NAV-1')
    const s2 = createSession(db, 'NAV-2')
    const s3 = createSession(db, 'NAV-3')
    await svc.send('NAV-1', s1.id, 'a')
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
    await svc.send('NAV-2', s2.id, 'b')
    await svc.send('NAV-3', s3.id, 'c')
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
      detection,
      skillsRoots: [],
      agentAccess: () => defaultAgentAccess(),
      onEvent: (e) => events.push(e),
      createQuery,
      maxSessions: 1
    })
    const s1 = createSession(db, 'NAV-1')
    await svc.send('NAV-1', s1.id, 'a')
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
      detection,
      skillsRoots: [],
      agentAccess: () => defaultAgentAccess(),
      onEvent: () => undefined,
      createQuery
    })
    await svc2.send('NAV-1', s1.id, 'b')
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
      detection,
      skillsRoots: [],
      agentAccess: () => defaultAgentAccess(),
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
        },
        modelPreferences: {}
      })
    })
    createCase(db, argusHome, { slug: 'C-1', title: 'a' })
    createCase(db, argusHome, { slug: 'C-2', title: 'b' })
    const c1 = createSession(db, 'C-1')
    const c2 = createSession(db, 'C-2')
    await svc.send('C-1', c1.id, 'hi')
    expect((captured[0].systemPrompt as { append: string }).append).toContain('brief.')
    expect(captured[0].model).toBe('claude-opus-4-8')
    expect(captured[0].permissionMode).toBe('acceptEdits')
    await endTurn(0)
    await svc.send('C-2', c2.id, 'hi') // maxSessions 1 → idle C-1 reaped
    expect(
      svc
        .states()
        .filter((s) => s.state === 'running')
        .map((s) => s.caseSlug)
    ).toEqual(['C-2'])
    await endTurn(1)
    maxSessions = 3
    await svc.send('C-1', c1.id, 'hi') // live read: no reap now
    expect(svc.states().filter((s) => s.state === 'running')).toHaveLength(2)
    await svc.stopAll()
  })

  it('falls back to the top ordered visible model when config.model is unset', async () => {
    const captured: Record<string, unknown>[] = []
    const createQuery: CreateQueryFn = (args) => {
      captured.push(args.options as Record<string, unknown>)
      const q = new AsyncQueue<unknown>()
      return Object.assign(
        { [Symbol.asyncIterator]: () => q[Symbol.asyncIterator]() },
        { interrupt: async () => q.end() }
      )
    }
    const svc = new AgentService({
      db,
      argusHome,
      detection,
      skillsRoots: [],
      agentAccess: () => defaultAgentAccess(),
      onEvent: () => {},
      createQuery,
      agentSettings: () => ({
        activeInstanceId: 'claude-default',
        maxSessions: 3,
        probeTimeoutMs: 10000,
        defaultPermissionMode: 'default' as const,
        personaAppend: '',
        providerInstances: {
          'claude-default': { driver: 'claude-agent-sdk', enabled: true, config: {} }
        },
        modelPreferences: {
          'claude-default': {
            hiddenModels: [],
            favoriteModels: ['claude-opus-4-8'],
            modelOrder: ['claude-sonnet-5', 'claude-opus-4-8']
          }
        }
      })
    })
    createCase(db, argusHome, { slug: 'C-1', title: 'a' })
    const c1 = createSession(db, 'C-1')
    await svc.send('C-1', c1.id, 'hi')
    // favorites group first regardless of modelOrder rank → claude-opus-4-8 is the top model
    expect(captured[0].model).toBe('claude-opus-4-8')
    await svc.stopAll()
  })

  it('stopSession evicts one live session; stopAllForCase evicts only that case (prefix-safe)', async () => {
    const { createQuery } = fakeCreateQuery()
    const svc = new AgentService({
      db,
      argusHome,
      detection,
      skillsRoots: [],
      agentAccess: () => defaultAgentAccess(),
      onEvent: (e) => events.push(e),
      createQuery,
      maxSessions: 10
    })
    const a = createSession(db, 'NAV-1')
    const b = createSession(db, 'NAV-1')
    const c = createSession(db, 'NAV-2')
    await svc.send('NAV-1', a.id, 'a')
    await svc.send('NAV-1', b.id, 'b')
    await svc.send('NAV-2', c.id, 'c')
    expect(svc.states()).toHaveLength(3)

    await svc.stopSession('NAV-1', a.id)
    expect(new Set(svc.states().map((s) => s.sessionId))).toEqual(new Set([b.id, c.id]))

    await svc.stopSession('NAV-1', 999999) // not live: must be a silent no-op
    expect(svc.states()).toHaveLength(2)

    await svc.stopAllForCase('NAV-1')
    expect(svc.states().map((s) => s.caseSlug)).toEqual(['NAV-2'])
    await svc.stopAll()
  })

  it('deleting a live session does not let the write-behind mirror resurrect the .jsonl file', async () => {
    const { createQuery } = fakeCreateQuery()
    const svc = new AgentService({
      db,
      argusHome,
      detection,
      skillsRoots: [],
      agentAccess: () => defaultAgentAccess(),
      onEvent: (e) => events.push(e),
      createQuery,
      // real SessionMirror (write-behind, 250ms timer) — a mocked mirror would not
      // reproduce the resurrection bug this test guards against
      mirrorFactory: (caseSlug, sessionId) =>
        new SessionMirror(
          db,
          path.join(caseDir(argusHome, caseSlug), 'sessions', `${sessionId}.jsonl`),
          {
            caseId: 1,
            sessionId
          }
        )
    })
    const s1 = createSession(db, 'NAV-1')
    await svc.send('NAV-1', s1.id, 'hello')
    const file = path.join(caseDir(argusHome, 'NAV-1'), 'sessions', `${s1.id}.jsonl`)

    // mirrors the sessions:delete IPC handler: stop the live session, then hard-delete
    await svc.stopSession('NAV-1', s1.id)
    deleteSession(db, argusHome, 'NAV-1', s1.id)
    expect(fs.existsSync(file)).toBe(false)

    // wait past the mirror's 250ms write-behind flush window
    await new Promise((r) => setTimeout(r, 350))
    expect(fs.existsSync(file)).toBe(false)
  })

  it('appends the contribute-back nudge only when the skill resolves enabled', async () => {
    // bundled-tier contribute-back skill in the shared skills dir
    const skillDir = path.join(argusHome, 'skills', 'contribute-back')
    fs.mkdirSync(skillDir, { recursive: true })
    fs.writeFileSync(
      path.join(skillDir, 'SKILL.md'),
      '---\nname: contribute-back\ndescription: draft proposals\n---\n'
    )
    const captured: Record<string, unknown>[] = []
    const createQuery: CreateQueryFn = (args) => {
      captured.push(args.options as Record<string, unknown>)
      const q = new AsyncQueue<unknown>()
      return Object.assign(
        { [Symbol.asyncIterator]: () => q[Symbol.asyncIterator]() },
        { interrupt: async () => q.end() }
      )
    }
    let access = defaultAgentAccess()
    const svc = new AgentService({
      db,
      argusHome,
      detection,
      skillsRoots: [],
      agentAccess: () => access,
      onEvent: () => {},
      createQuery
    })
    const appendOf = (i: number): string => (captured[i].systemPrompt as { append: string }).append

    // enabled (default) → nudge present
    const s1 = createSession(db, 'NAV-1')
    await svc.send('NAV-1', s1.id, 'hi')
    expect(appendOf(0)).toContain('mcp__argus__write_proposal')

    // disabled via agent access → a fresh session gets no nudge
    access = agentAccessSchema.parse({ skills: { 'bundled/contribute-back': false } })
    const s2 = createSession(db, 'NAV-2')
    await svc.send('NAV-2', s2.id, 'hi')
    expect(appendOf(1)).not.toContain('mcp__argus__write_proposal')

    // a user-tier shadow wins resolution: its enabled state governs, not the bundled key
    const userDir = path.join(argusHome, 'skills-user', 'contribute-back')
    fs.mkdirSync(userDir, { recursive: true })
    fs.writeFileSync(
      path.join(userDir, 'SKILL.md'),
      '---\nname: contribute-back\ndescription: user override\n---\n'
    )
    const s3 = createSession(db, 'NAV-3')
    await svc.send('NAV-3', s3.id, 'hi')
    expect(appendOf(2)).toContain('mcp__argus__write_proposal')
    await svc.stopAll()
  })
})
