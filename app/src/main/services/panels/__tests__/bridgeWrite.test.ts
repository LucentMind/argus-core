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
  sendToAgent(cs, sid, text) {
    calls.push(`send:${cs}:${sid}:${text}`)
  },
  async emitFinding(cs, sid, input) {
    calls.push(`finding:${cs}:${sid}:${input.title}`)
    return { ok: true, findingId: 99 }
  },
  cite(t, relPath, line) {
    calls.push(`cite:${t.caseSlug}:${t.sessionId}:${relPath}:${line}`)
  },
  async ingestEvidence(cs, sid, input) {
    calls.push(`ingest:${cs}:${sid}:${input.filename}`)
    return { ok: true, evidenceId: '42' }
  }
}

beforeEach(() => {
  home = fs.mkdtempSync(path.join(os.tmpdir(), 'argus-write-'))
  db = openDb(path.join(home, 'argus.db'))
  createCase(db, home, { slug: 'CASE-A', title: 'A' })
  calls = []
})

const bind = (permissions: string[], sessionId: number | null, network: string[] = []) =>
  createPanelBridge({
    db, argusHome: home, caseSlug: 'CASE-A',
    permissions: permissions as never, sessionId, writeSink: sink, network
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
  expect(b.sendToAgent!('look here')).toEqual({ ok: true })
  expect(await b.emitFinding!({ title: 'T', markdown: 'm' })).toEqual({ ok: true, findingId: 99 })
  expect(b.cite!('evidence/log.txt', 12)).toEqual({ ok: true })
  expect(calls).toEqual([
    'send:CASE-A:4:look here',
    'finding:CASE-A:4:T',
    'cite:CASE-A:4:evidence/log.txt:12'
  ])
})

it('throws when a write verb is used with no bound session', () => {
  const b = bind(['sendToAgent'], null)
  expect(() => b.sendToAgent!('x')).toThrow(/no bound session/)
})

it('ingestEvidence: routes a bytes source to the sink', async () => {
  const b = bind(['ingestEvidence'], 4)
  const res = await b.ingestEvidence!({ source: { bytes: new Uint8Array([1, 2, 3]) }, filename: 'a.bin' })
  expect(res).toEqual({ ok: true, evidenceId: '42' })
  expect(calls).toEqual(['ingest:CASE-A:4:a.bin'])
})

it('ingestEvidence: rejects a bytes source over the size ceiling without calling the sink', async () => {
  const b = bind(['ingestEvidence'], 4)
  const big = new Uint8Array(25 * 1024 * 1024 + 1)
  const res = await b.ingestEvidence!({ source: { bytes: big }, filename: 'big.bin' })
  expect(res).toEqual({ ok: false, reason: 'bytes-too-large' })
  expect(calls).toEqual([])
})

it('ingestEvidence: allows a url source whose origin matches network[]', async () => {
  const b = bind(['ingestEvidence'], 4, ['https://tiles.example.com'])
  const res = await b.ingestEvidence!({
    source: { url: 'https://tiles.example.com/path/to/file.png' },
    filename: 'tile.png'
  })
  expect(res).toEqual({ ok: true, evidenceId: '42' })
})

it('ingestEvidence: rejects a url source whose origin is not declared (no prefix bypass)', async () => {
  const b = bind(['ingestEvidence'], 4, ['https://tiles.example.com'])
  const res = await b.ingestEvidence!({
    source: { url: 'https://tiles.example.com.attacker.com/evil.png' },
    filename: 'x.png'
  })
  expect(res).toEqual({ ok: false, reason: 'origin-not-allowed' })
  expect(calls).toEqual([])
})

it('ingestEvidence: throws when used with no bound session', async () => {
  const b = bind(['ingestEvidence'], null)
  await expect(
    b.ingestEvidence!({ source: { bytes: new Uint8Array([1]) }, filename: 'a.bin' })
  ).rejects.toThrow(/no bound session/)
})
