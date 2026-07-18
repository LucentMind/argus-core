import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { openDb } from '../../db'
import { createCase } from '../../caseService'
import { AgentService } from '../registry'
import { createSession, deleteSession, setSessionModel } from '../sessionStore'
import { AsyncQueue } from '../asyncQueue'
import { defaultAgentAccess, agentAccessSchema } from '../../../../shared/agentAccess'
import { createDetection } from '../../packs/detection'
import { SessionMirror } from '../mirror'
import { caseDir } from '../../paths'
import type { CreateQueryFn } from '../drivers/claude'
import type { AgentEvent } from '../../../../shared/agent-events'
import type { DatabaseSync } from 'node:sqlite'
import { fingerprintServers, McpService } from '../../mcp'
import { ConnectorRegistry } from '../../connectors'
import { SecretStore, type SecretCrypto } from '../../secrets'
import type { AgentDriver, DriverKind, DriverSession } from '../driver'
import { CLAUDE_TOOL_TAXONOMY } from '../risk'
import { PERMISSION_MODES } from '../../../../shared/settings'

let tmp: string, argusHome: string, db: DatabaseSync, events: AgentEvent[]
const detection = createDetection()

const fakeCrypto = (): SecretCrypto => ({
  isEncryptionAvailable: () => true,
  encryptString: (s) => Buffer.from(`enc:${s}`, 'utf8'),
  decryptString: (b) => b.toString('utf8').slice(4)
})

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
    const a = createSession(db, 'NAV-1', 'claude-agent-sdk')
    const b = createSession(db, 'NAV-1', 'claude-agent-sdk')
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
    const s1 = createSession(db, 'NAV-1', 'claude-agent-sdk')
    const s2 = createSession(db, 'NAV-2', 'claude-agent-sdk')
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

  it('rebuilds a live session when the composed connector fingerprint changes', async () => {
    const { createQuery, queues, optionsLog } = fakeCreateQuery()
    let servers: Record<string, unknown> = {}
    const svc = new AgentService({
      db,
      argusHome,
      detection,
      skillsRoots: [],
      agentAccess: () => defaultAgentAccess(),
      onEvent: (e) => events.push(e),
      createQuery,
      composeMcp: async () => ({ servers, skipped: [], fingerprint: fingerprintServers(servers) })
    })
    const s = createSession(db, 'NAV-1', 'claude-agent-sdk')
    await svc.send('NAV-1', s.id, 'first') // built with NO connectors
    queues[0].push({ type: 'result', is_error: false }) // finish the turn → idle
    await new Promise((r) => setTimeout(r, 10))
    expect(optionsLog).toHaveLength(1)
    expect(optionsLog[0].mcpServers).not.toHaveProperty('rovo')

    // the user authorizes the connector
    servers = { rovo: { type: 'sse', url: 'https://x/y', headers: { Authorization: 'Bearer t' } } }
    await svc.send('NAV-1', s.id, 'second')

    expect(
      events.some((e) => e.type === 'session.exited' && e.payload.reason === 'reconfigured')
    ).toBe(true)
    expect(optionsLog).toHaveLength(2)
    expect(optionsLog[1].mcpServers).toHaveProperty('rovo')
    expect(svc.states()).toHaveLength(1) // rebuilt, not leaked
    await svc.stopAll()
  })

  it('reuses a live session when the fingerprint is unchanged', async () => {
    const { createQuery, queues, optionsLog } = fakeCreateQuery()
    const servers = { rovo: { type: 'sse', url: 'https://x/y' } }
    const svc = new AgentService({
      db,
      argusHome,
      detection,
      skillsRoots: [],
      agentAccess: () => defaultAgentAccess(),
      onEvent: (e) => events.push(e),
      createQuery,
      composeMcp: async () => ({ servers, skipped: [], fingerprint: fingerprintServers(servers) })
    })
    const s = createSession(db, 'NAV-1', 'claude-agent-sdk')
    await svc.send('NAV-1', s.id, 'first')
    queues[0].push({ type: 'result', is_error: false })
    await new Promise((r) => setTimeout(r, 10))
    await svc.send('NAV-1', s.id, 'second')
    expect(optionsLog).toHaveLength(1) // one construction only
    expect(events.some((e) => e.type === 'session.exited')).toBe(false)
    await svc.stopAll()
  })

  it('never tears down a session mid-turn, even when the fingerprint changed', async () => {
    const { createQuery, optionsLog } = fakeCreateQuery()
    let servers: Record<string, unknown> = {}
    const svc = new AgentService({
      db,
      argusHome,
      detection,
      skillsRoots: [],
      agentAccess: () => defaultAgentAccess(),
      onEvent: (e) => events.push(e),
      createQuery,
      composeMcp: async () => ({ servers, skipped: [], fingerprint: fingerprintServers(servers) })
    })
    const s = createSession(db, 'NAV-1', 'claude-agent-sdk')
    await svc.send('NAV-1', s.id, 'first') // no result pushed → activeTurn stays true
    servers = { rovo: { type: 'sse', url: 'https://x/y' } }
    await svc.send('NAV-1', s.id, 'second')
    expect(events.some((e) => e.type === 'session.exited')).toBe(false)
    expect(optionsLog).toHaveLength(1)
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
    const s1 = createSession(db, 'NAV-1', 'claude-agent-sdk')
    const s2 = createSession(db, 'NAV-2', 'claude-agent-sdk')
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
    const s1 = createSession(db, 'NAV-1', 'claude-agent-sdk')
    const s2 = createSession(db, 'NAV-2', 'claude-agent-sdk')
    const s3 = createSession(db, 'NAV-3', 'claude-agent-sdk')
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
    const s1 = createSession(db, 'NAV-1', 'claude-agent-sdk')
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
    const sess = db.prepare(`SELECT driver_cursor FROM sessions`).get() as {
      driver_cursor: string
    }
    expect(sess.driver_cursor).toBe('22222222-2222-4222-8222-222222222222')
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
    const c1 = createSession(db, 'C-1', 'claude-agent-sdk')
    const c2 = createSession(db, 'C-2', 'claude-agent-sdk')
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
    const c1 = createSession(db, 'C-1', 'claude-agent-sdk')
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
    const a = createSession(db, 'NAV-1', 'claude-agent-sdk')
    const b = createSession(db, 'NAV-1', 'claude-agent-sdk')
    const c = createSession(db, 'NAV-2', 'claude-agent-sdk')
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
    const s1 = createSession(db, 'NAV-1', 'claude-agent-sdk')
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
    const s1 = createSession(db, 'NAV-1', 'claude-agent-sdk')
    await svc.send('NAV-1', s1.id, 'hi')
    expect(appendOf(0)).toContain('mcp__argus__write_proposal')

    // disabled via agent access → a fresh session gets no nudge
    access = agentAccessSchema.parse({ skills: { 'bundled/contribute-back': false } })
    const s2 = createSession(db, 'NAV-2', 'claude-agent-sdk')
    await svc.send('NAV-2', s2.id, 'hi')
    expect(appendOf(1)).not.toContain('mcp__argus__write_proposal')

    // a user-tier shadow wins resolution: its enabled state governs, not the bundled key
    const userDir = path.join(argusHome, 'skills-user', 'contribute-back')
    fs.mkdirSync(userDir, { recursive: true })
    fs.writeFileSync(
      path.join(userDir, 'SKILL.md'),
      '---\nname: contribute-back\ndescription: user override\n---\n'
    )
    const s3 = createSession(db, 'NAV-3', 'claude-agent-sdk')
    await svc.send('NAV-3', s3.id, 'hi')
    expect(appendOf(2)).toContain('mcp__argus__write_proposal')

    // converse: the user-tier shadow (still on disk from NAV-3) disabled at its own key
    // suppresses the nudge too — resolution follows the shadow's key, not the bundled one
    access = agentAccessSchema.parse({ skills: { 'user/contribute-back': false } })
    const s4 = createSession(db, 'NAV-4', 'claude-agent-sdk')
    await svc.send('NAV-4', s4.id, 'hi')
    expect(appendOf(3)).not.toContain('mcp__argus__write_proposal')

    await svc.stopAll()
  })

  it('regression (2026-07-16): a session built before authorize self-heals on the next send', async () => {
    const connectors = new ConnectorRegistry(argusHome)
    const secrets = new SecretStore(argusHome, fakeCrypto())
    try {
      connectors.patch({
        rovo: {
          kind: 'http',
          config: { url: 'https://mcp.atlassian.com/v1/sse', transport: 'sse', oauth: true }
        }
      })
      let token: string | null = null // not yet authorized
      const mcp = new McpService({
        registry: connectors,
        secrets,
        toolRisk: () => ({}),
        oauth: {
          accessToken: () => token,
          refresh: async () => token != null,
          status: () => (token != null ? 'authorized' : 'not-authorized')
        }
      })
      const { createQuery, queues, optionsLog } = fakeCreateQuery()
      const svc = new AgentService({
        db,
        argusHome,
        detection,
        skillsRoots: [],
        agentAccess: () => defaultAgentAccess(),
        onEvent: (e) => events.push(e),
        createQuery,
        composeMcp: () => mcp.composeForSession()
      })
      const s = createSession(db, 'NAV-1', 'claude-agent-sdk')

      // 1. no token: the connector is absent and the skip is logged
      await svc.send('NAV-1', s.id, 'comment on the jira ticket')
      queues[0].push({ type: 'result', is_error: false }) // finish the turn → idle
      await new Promise((r) => setTimeout(r, 10))
      expect(optionsLog[0].mcpServers).not.toHaveProperty('rovo')
      expect(events.some((e) => e.type === 'session.mcp.skipped')).toBe(true)

      // 2. the user authorizes. NOTE: no clearRuntime, no restart, no case switch.
      token = 'live-token'

      // 3. the next send self-heals
      await svc.send('NAV-1', s.id, 'try again')
      expect(optionsLog[1].mcpServers).toHaveProperty('rovo')
      expect(
        events.some((e) => e.type === 'session.exited' && e.payload.reason === 'reconfigured')
      ).toBe(true)
      await svc.stopAll()
    } finally {
      connectors.close()
      secrets.close()
    }
  })
})

/** A minimal AgentDriver stub that just records which `kind` it was constructed under
 *  every time `createSession` is invoked — enough to observe which driver instance
 *  AgentService actually used for a given session, without a real SDK/CLI transport. */
function stubDriver(kind: DriverKind, calls: DriverKind[]): AgentDriver {
  return {
    kind,
    toolTaxonomy: CLAUDE_TOOL_TAXONOMY,
    authFixHint: 'stub hint',
    capabilities: {
      permissionModes: PERMISSION_MODES,
      editableApprovals: true,
      costReporting: true
    },
    createSession(): DriverSession {
      calls.push(kind)
      const queue = new AsyncQueue<AgentEvent>()
      return {
        events: () => queue,
        send: () => {},
        interrupt: async () => {
          queue.end()
        },
        end: () => queue.end()
      }
    },
    probeAuth: async () => ({ ok: true, detail: '' })
  }
}

describe('AgentService driver resolution (Phase 3 checkpoint item 5)', () => {
  it('a thunk `deps.driver` is re-invoked at each getOrCreate, so the NEXT session picks up a provider switch', async () => {
    const calls: DriverKind[] = []
    let active: AgentDriver = stubDriver('claude-agent-sdk', calls)
    const svc = new AgentService({
      db,
      argusHome,
      detection,
      skillsRoots: [],
      agentAccess: () => defaultAgentAccess(),
      onEvent: (e) => events.push(e),
      driver: () => active
    })
    const s1 = createSession(db, 'NAV-1', 'claude-agent-sdk')
    await svc.send('NAV-1', s1.id, 'hello under claude')

    // Simulate a settings change flipping the active provider mid-app-lifetime.
    active = stubDriver('github-copilot', calls)
    const s2 = createSession(db, 'NAV-2', 'github-copilot')
    await svc.send('NAV-2', s2.id, 'hello under copilot')

    expect(calls).toEqual(['claude-agent-sdk', 'github-copilot'])
    await svc.stopAll()
  })

  it('a plain-value `deps.driver` is used as-is for every session (back-compat, no thunk)', async () => {
    const calls: DriverKind[] = []
    const fixed = stubDriver('claude-agent-sdk', calls)
    const svc = new AgentService({
      db,
      argusHome,
      detection,
      skillsRoots: [],
      agentAccess: () => defaultAgentAccess(),
      onEvent: (e) => events.push(e),
      driver: fixed
    })
    const s1 = createSession(db, 'NAV-1', 'claude-agent-sdk')
    const s2 = createSession(db, 'NAV-2', 'claude-agent-sdk')
    await svc.send('NAV-1', s1.id, 'a')
    await svc.send('NAV-2', s2.id, 'b')
    expect(calls).toEqual(['claude-agent-sdk', 'claude-agent-sdk'])
    await svc.stopAll()
  })

  it('a plain-value `deps.createQuery` (no `driver`) still resolves to the Claude driver, once, as before', async () => {
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
    const s1 = createSession(db, 'NAV-1', 'claude-agent-sdk')
    await svc.send('NAV-1', s1.id, 'hi')
    expect(svc.states().some((s) => s.sessionId === s1.id)).toBe(true)
    await svc.stopAll()
  })
})

describe('AgentService — per-session provider and model', () => {
  const AGENT_SETTINGS = {
    activeInstanceId: 'claude-default',
    maxSessions: 3,
    probeTimeoutMs: 10000,
    defaultPermissionMode: 'default' as const,
    personaAppend: '',
    providerInstances: {
      'claude-default': { driver: 'claude-agent-sdk', enabled: true, config: {} },
      'claude-work': { driver: 'claude-agent-sdk', enabled: true, config: {} }
    },
    modelPreferences: {}
  }

  it('uses the model pinned on the session, not the global default', async () => {
    const { createQuery, optionsLog } = fakeCreateQuery()
    const svc = new AgentService({
      db,
      argusHome,
      detection,
      skillsRoots: [],
      agentAccess: () => defaultAgentAccess(),
      onEvent: (e) => events.push(e),
      createQuery,
      agentSettings: () => AGENT_SETTINGS
    })
    const s = createSession(db, 'NAV-1', {
      driverKind: 'claude-agent-sdk',
      instanceId: 'claude-default',
      model: 'claude-haiku-4-5'
    })
    await svc.send('NAV-1', s.id, 'hi')
    expect(optionsLog[0].model).toBe('claude-haiku-4-5')
    await svc.stopAll()
  })

  it('rebuilds a live idle session when its model is re-pinned', async () => {
    // The model is frozen at query() construction, exactly like mcpServers — re-pinning
    // must tear down and rebuild or the chat keeps answering on the old model.
    const { createQuery, queues, optionsLog } = fakeCreateQuery()
    const svc = new AgentService({
      db,
      argusHome,
      detection,
      skillsRoots: [],
      agentAccess: () => defaultAgentAccess(),
      onEvent: (e) => events.push(e),
      createQuery,
      agentSettings: () => AGENT_SETTINGS
    })
    const s = createSession(db, 'NAV-1', {
      driverKind: 'claude-agent-sdk',
      instanceId: 'claude-default',
      model: 'claude-opus-4-8'
    })
    await svc.send('NAV-1', s.id, 'first')
    queues[0].push({ type: 'result', is_error: false })
    await new Promise((r) => setTimeout(r, 10))

    setSessionModel(db, s.id, {
      driverKind: 'claude-agent-sdk',
      instanceId: 'claude-default',
      model: 'claude-sonnet-5'
    })
    await svc.send('NAV-1', s.id, 'second')

    expect(
      events.some((e) => e.type === 'session.exited' && e.payload.reason === 'reconfigured')
    ).toBe(true)
    expect(optionsLog).toHaveLength(2)
    expect(optionsLog[1].model).toBe('claude-sonnet-5')
    expect(svc.states()).toHaveLength(1)
    await svc.stopAll()
  })

  it('does not rebuild when the pinned model is unchanged', async () => {
    const { createQuery, queues, optionsLog } = fakeCreateQuery()
    const svc = new AgentService({
      db,
      argusHome,
      detection,
      skillsRoots: [],
      agentAccess: () => defaultAgentAccess(),
      onEvent: (e) => events.push(e),
      createQuery,
      agentSettings: () => AGENT_SETTINGS
    })
    const s = createSession(db, 'NAV-1', {
      driverKind: 'claude-agent-sdk',
      instanceId: 'claude-default',
      model: 'claude-opus-4-8'
    })
    await svc.send('NAV-1', s.id, 'first')
    queues[0].push({ type: 'result', is_error: false })
    await new Promise((r) => setTimeout(r, 10))
    await svc.send('NAV-1', s.id, 'second')
    expect(optionsLog).toHaveLength(1)
    await svc.stopAll()
  })

  it('never tears down a mid-turn session even when the model was re-pinned', async () => {
    const { createQuery, optionsLog } = fakeCreateQuery()
    const svc = new AgentService({
      db,
      argusHome,
      detection,
      skillsRoots: [],
      agentAccess: () => defaultAgentAccess(),
      onEvent: (e) => events.push(e),
      createQuery,
      agentSettings: () => AGENT_SETTINGS
    })
    const s = createSession(db, 'NAV-1', {
      driverKind: 'claude-agent-sdk',
      instanceId: 'claude-default',
      model: 'claude-opus-4-8'
    })
    await svc.send('NAV-1', s.id, 'first') // turn still in flight
    setSessionModel(db, s.id, {
      driverKind: 'claude-agent-sdk',
      instanceId: 'claude-default',
      model: 'claude-sonnet-5'
    })
    await svc.send('NAV-1', s.id, 'second')
    expect(optionsLog).toHaveLength(1) // rebuild deferred to the next idle send
    expect(events.some((e) => e.type === 'session.exited')).toBe(false)
    await svc.stopAll()
  })

  it('falls back to settings for an unpinned (legacy) session', async () => {
    const { createQuery, optionsLog } = fakeCreateQuery()
    const svc = new AgentService({
      db,
      argusHome,
      detection,
      skillsRoots: [],
      agentAccess: () => defaultAgentAccess(),
      onEvent: (e) => events.push(e),
      createQuery,
      agentSettings: () => AGENT_SETTINGS
    })
    const s = createSession(db, 'NAV-1', 'claude-agent-sdk') // nulls
    await svc.send('NAV-1', s.id, 'hi')
    expect(optionsLog[0].model).toBe('claude-fable-5') // top of the default instance's catalog
    await svc.stopAll()
  })
})
