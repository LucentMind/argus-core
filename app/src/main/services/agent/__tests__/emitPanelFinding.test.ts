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
import type { CreateQueryFn } from '../drivers/claude'
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
  home = fs.mkdtempSync(path.join(os.tmpdir(), 'argus-pf-'))
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
    db,
    argusHome: home,
    detection,
    skillsRoots: [],
    agentAccess: () => defaultAgentAccess(),
    onEvent: (e) => events.push(e),
    createQuery: fakeCreateQuery()
  })

it('raises a MEDIUM editable card and, on approve, writes the (edited) finding', async () => {
  const svc = mkService()
  const s = createSession(db, 'NAV-1')
  const p = svc.emitPanelFinding('NAV-1', s.id, { title: 'T', markdown: 'body' })

  // the card surfaces as request.opened with the panel-finding tool + MEDIUM + input
  await new Promise((r) => setTimeout(r, 5))
  const opened = events.find((e) => e.type === 'request.opened')!
  expect(opened.payload.tool).toBe('mcp__argus__panel_emit_finding')
  expect(opened.payload.risk).toBe('MEDIUM')
  expect(opened.payload.input).toEqual({ title: 'T', markdown: 'body' })

  // user edits the body and approves
  svc.respond('NAV-1', s.id, {
    requestId: opened.payload.requestId,
    kind: 'allow',
    updatedInput: { title: 'T', markdown: 'EDITED body' }
  })
  const res = await p
  expect(res.ok).toBe(true)
  expect(res.findingId).toBeGreaterThan(0)
  expect(fs.readFileSync(path.join(caseDir(home, 'NAV-1'), 'findings.md'), 'utf8')).toContain(
    'EDITED body'
  )
  await svc.stopAll()
})

it('returns { ok:false } and writes nothing on deny', async () => {
  const svc = mkService()
  const s = createSession(db, 'NAV-1')
  const p = svc.emitPanelFinding('NAV-1', s.id, { title: 'T', markdown: 'body' })
  await new Promise((r) => setTimeout(r, 5))
  const opened = events.find((e) => e.type === 'request.opened')!
  svc.respond('NAV-1', s.id, { requestId: opened.payload.requestId, kind: 'deny' })
  expect(await p).toEqual({ ok: false })
  // createCase scaffolds findings.md with just its header at case creation, so on deny the
  // file exists but must be untouched — no finding block appended.
  expect(fs.readFileSync(path.join(caseDir(home, 'NAV-1'), 'findings.md'), 'utf8')).toBe(
    '# Findings — NAV-1\n'
  )
  await svc.stopAll()
})
