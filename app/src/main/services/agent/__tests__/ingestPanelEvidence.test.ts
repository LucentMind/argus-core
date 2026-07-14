import { it, expect, beforeEach, afterEach } from 'vitest'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import type { DatabaseSync } from 'node:sqlite'
import { openDb } from '../../db'
import { createCase } from '../../caseService'
import { AgentService } from '../registry'
import { createSession } from '../sessionStore'
import { AsyncQueue } from '../asyncQueue'
import { defaultAgentAccess } from '../../../../shared/agentAccess'
import { createDetection } from '../../packs/detection'
import { caseDir } from '../../paths'
import type { CreateQueryFn } from '../session'
import type { AgentEvent } from '../../../../shared/agent-events'

const detection = createDetection()
let home: string, db: DatabaseSync, events: AgentEvent[]

const fakeCreateQuery = (): CreateQueryFn => () => {
  const q = new AsyncQueue<unknown>()
  return Object.assign(
    { [Symbol.asyncIterator]: () => q[Symbol.asyncIterator]() },
    { interrupt: async () => q.end() }
  )
}

beforeEach(() => {
  home = fs.mkdtempSync(path.join(os.tmpdir(), 'argus-pie-'))
  db = openDb(path.join(home, 'argus.db'))
  events = []
  createCase(db, home, { slug: 'NAV-1', title: 'NAV-1' })
})
afterEach(() => {
  db.close()
  fs.rmSync(home, { recursive: true, force: true })
})

const mkService = (): AgentService =>
  new AgentService({
    db, argusHome: home, detection, skillsRoots: [],
    agentAccess: () => defaultAgentAccess(),
    onEvent: (e) => events.push(e),
    createQuery: fakeCreateQuery()
  })

it('raises a MEDIUM editable card and, on approve, ingests the (edited) filename from bytes', async () => {
  const svc = mkService()
  const s = createSession(db, 'NAV-1')
  const p = svc.ingestPanelEvidence('NAV-1', s.id, {
    source: { bytes: Buffer.from('hello from panel') },
    filename: 'note.txt'
  })

  await new Promise((r) => setTimeout(r, 5))
  const opened = events.find((e) => e.type === 'request.opened')!
  expect(opened.payload.tool).toBe('mcp__argus__panel_ingest_evidence')
  expect(opened.payload.risk).toBe('MEDIUM')
  expect(opened.payload.input).toEqual({ filename: 'note.txt', source: '16 bytes from panel' })

  svc.respond('NAV-1', s.id, {
    requestId: opened.payload.requestId, kind: 'allow',
    updatedInput: { filename: 'renamed.txt' }
  })
  const res = await p
  expect(res.ok).toBe(true)
  if (res.ok) expect(Number(res.evidenceId)).toBeGreaterThan(0)
  expect(
    fs.readFileSync(path.join(caseDir(home, 'NAV-1'), 'evidence', 'renamed.txt'), 'utf8')
  ).toBe('hello from panel')
  const ingested = events.find((e) => e.type === 'case.evidence.ingested')!
  expect(ingested.payload.relPath).toBe('evidence/renamed.txt')
  await svc.stopAll()
})

it('returns { ok:false, reason:"denied" } and writes nothing on deny', async () => {
  const svc = mkService()
  const s = createSession(db, 'NAV-1')
  const p = svc.ingestPanelEvidence('NAV-1', s.id, {
    source: { bytes: Buffer.from('x') },
    filename: 'note.txt'
  })
  await new Promise((r) => setTimeout(r, 5))
  const opened = events.find((e) => e.type === 'request.opened')!
  svc.respond('NAV-1', s.id, { requestId: opened.payload.requestId, kind: 'deny' })
  expect(await p).toEqual({ ok: false, reason: 'denied' })
  expect(fs.existsSync(path.join(caseDir(home, 'NAV-1'), 'evidence', 'note.txt'))).toBe(false)
  await svc.stopAll()
})
