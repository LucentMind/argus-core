import { it, expect, beforeEach } from 'vitest'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import type { DatabaseSync } from 'node:sqlite'
import { openDb } from '../../db'
import { createCase } from '../../caseService'
import { createPanelBridge, type PanelWriteSink } from '../bridge'

let home: string, db: DatabaseSync, calls: string[]
const sink: PanelWriteSink = {
  async sendToAgent(cs, sid, text) {
    calls.push(`send:${cs}:${sid}:${text}`)
    return 7
  },
  async emitFinding(cs, sid, input) {
    calls.push(`finding:${cs}:${sid}:${input.title}`)
    return { ok: true, findingId: 99 }
  },
  cite(t, relPath, line) {
    calls.push(`cite:${t.caseSlug}:${t.sessionId}:${relPath}:${line}`)
  }
}

beforeEach(() => {
  home = fs.mkdtempSync(path.join(os.tmpdir(), 'argus-write-'))
  db = openDb(path.join(home, 'argus.db'))
  createCase(db, home, { slug: 'CASE-A', title: 'A' })
  calls = []
})

const bind = (permissions: string[], sessionId: number | null) =>
  createPanelBridge({
    db, argusHome: home, caseSlug: 'CASE-A',
    permissions: permissions as never, sessionId, writeSink: sink
  })

it('exposes only granted write verbs', () => {
  const b = bind(['sendToAgent'], 1)
  expect(typeof b.sendToAgent).toBe('function')
  expect(b.emitFinding).toBeUndefined()
  expect(b.cite).toBeUndefined()
})

it('omits write verbs when no sink is supplied', () => {
  const b = createPanelBridge({
    db, argusHome: home, caseSlug: 'CASE-A',
    permissions: ['sendToAgent', 'cite'] as never, sessionId: 1
  })
  expect(b.sendToAgent).toBeUndefined()
  expect(b.cite).toBeUndefined()
})

it('routes write verbs to the sink with the bound case+session', async () => {
  const b = bind(['sendToAgent', 'emitFinding', 'cite'], 4)
  expect(await b.sendToAgent!('look here')).toEqual({ ok: true, turnIndex: 7 })
  expect(await b.emitFinding!({ title: 'T', markdown: 'm' })).toEqual({ ok: true, findingId: 99 })
  expect(b.cite!('evidence/log.txt', 12)).toEqual({ ok: true })
  expect(calls).toEqual([
    'send:CASE-A:4:look here',
    'finding:CASE-A:4:T',
    'cite:CASE-A:4:evidence/log.txt:12'
  ])
})

it('throws when a write verb is used with no bound session', async () => {
  const b = bind(['sendToAgent'], null)
  await expect(b.sendToAgent!('x')).rejects.toThrow(/no bound session/)
})
