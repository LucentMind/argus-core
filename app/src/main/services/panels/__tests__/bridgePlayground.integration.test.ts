import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import type { DatabaseSync } from 'node:sqlite'
import { openDb } from '../../db'
import { createCase } from '../../caseService'
import { caseDir } from '../../paths'
import { createDetection } from '../../packs/detection'
import { loadPacks } from '../../packs/loader'
import { PackRegistry } from '../../packs/registry'
import { seededPacksDir } from '../../packs/paths'
import { AgentService } from '../../agent/registry'
import { createSession } from '../../agent/sessionStore'
import { AsyncQueue } from '../../agent/asyncQueue'
import { defaultAgentAccess } from '../../../../shared/agentAccess'
import { createPanelBridge, type PanelWriteSink } from '../bridge'
import type { CreateQueryFn } from '../../agent/session'
import type { AgentEvent } from '../../../../shared/agent-events'

// panels/__tests__ → up 5 = app/ (seededPacksDir → <repo>/packs).
const packsSrc = seededPacksDir(path.resolve(__dirname, '../../../../..'))
const detection = createDetection()

const fakeCreateQuery: CreateQueryFn = () => {
  const q = new AsyncQueue<unknown>()
  return Object.assign(
    { [Symbol.asyncIterator]: () => q[Symbol.asyncIterator]() },
    { interrupt: async () => q.end() }
  )
}

let home: string, db: DatabaseSync, events: AgentEvent[], cites: unknown[]

beforeEach(() => {
  home = fs.mkdtempSync(path.join(os.tmpdir(), 'argus-pg-int-'))
  db = openDb(path.join(home, 'argus.db'))
  createCase(db, home, { slug: 'NAV-1', title: 'NAV-1' })
  events = []
  cites = []
})
afterEach(() => {
  db.close()
  fs.rmSync(home, { recursive: true, force: true })
})

describe('bridge playground — upstream verbs end to end', () => {
  it('declares the playground window with the upstream verb permissions', () => {
    const { packs, errors } = loadPacks(packsSrc)
    expect(errors).toEqual([])
    const reg = new PackRegistry(packs)
    const w = reg
      .windowDecls()
      .find((d) => d.packId === 'sample-bridge-playground' && d.decl.id === 'playground')!
    expect(w.decl.permissions).toEqual(
      expect.arrayContaining([
        'getCaseContext',
        'requestEvidence',
        'readEvidence',
        'cite',
        'emitFinding',
        'sendToAgent'
      ])
    )
  })

  it('executes sendToAgent, emitFinding (approve) and cite against a seeded case', async () => {
    const agent = new AgentService({
      db,
      argusHome: home,
      detection,
      skillsRoots: [],
      agentAccess: () => defaultAgentAccess(),
      onEvent: (e) => events.push(e),
      createQuery: fakeCreateQuery
    })
    const staged: Array<{ caseSlug: string; sessionId: number; text: string }> = []
    const sink: PanelWriteSink = {
      sendToAgent: (caseSlug, sessionId, text) => staged.push({ caseSlug, sessionId, text }),
      emitFinding: (cs, sid, input) => agent.emitPanelFinding(cs, sid, input),
      cite: (target, relPath, line) => cites.push({ ...target, relPath, line }),
      ingestEvidence: async () => ({ ok: false, reason: 'not-implemented-in-fixture' })
    }
    const s = createSession(db, 'NAV-1')
    const bridge = createPanelBridge({
      db,
      argusHome: home,
      caseSlug: 'NAV-1',
      permissions: ['sendToAgent', 'emitFinding', 'cite'],
      sessionId: s.id,
      writeSink: sink
    })

    // sendToAgent → stages the text for the bound case+session (no turn is sent)
    expect(bridge.sendToAgent!('please investigate')).toEqual({ ok: true })
    expect(staged).toEqual([{ caseSlug: 'NAV-1', sessionId: s.id, text: 'please investigate' }])
    const turns = db
      .prepare('SELECT COUNT(*) n FROM turns WHERE session_id = ?')
      .get(s.id) as { n: number }
    expect(turns.n).toBe(0)

    // emitFinding → card raised, approve → finding written
    const p = bridge.emitFinding!({ title: 'PG', markdown: 'from playground' })
    await new Promise((r) => setTimeout(r, 5))
    const opened = events.find((e) => e.type === 'request.opened')!
    agent.respond('NAV-1', s.id, { requestId: opened.payload.requestId, kind: 'allow' })
    expect((await p).ok).toBe(true)
    expect(fs.readFileSync(path.join(caseDir(home, 'NAV-1'), 'findings.md'), 'utf8')).toContain(
      'PG'
    )

    // cite → broadcast payload with the bound case+session
    bridge.cite!('evidence/sample.txt', 5)
    expect(cites).toEqual([
      { caseSlug: 'NAV-1', sessionId: s.id, relPath: 'evidence/sample.txt', line: 5 }
    ])

    await agent.stopAll()
  })
})
