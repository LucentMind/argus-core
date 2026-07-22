import { it, expect, beforeEach } from 'vitest'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import type { DatabaseSync } from 'node:sqlite'
import { openDb } from '../../db'
import { createCase } from '../../caseService'
import { createPanelBridge, type PanelBridge, type PanelWriteSink } from '../bridge'

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
  },
  async sendImageToAgent(cs, sid, input) {
    calls.push(
      `image:${cs}:${sid}:${input.filename}:${input.bytes.byteLength}:${input.caption ?? ''}`
    )
    return { ok: true, evidenceId: '77' }
  }
}

beforeEach(() => {
  home = fs.mkdtempSync(path.join(os.tmpdir(), 'argus-write-'))
  db = openDb(path.join(home, 'argus.db'))
  createCase(db, home, { slug: 'CASE-A', title: 'A' })
  calls = []
})

const bind = (
  permissions: string[],
  sessionId: number | null,
  network: string[] = []
): PanelBridge =>
  createPanelBridge({
    db,
    argusHome: home,
    caseSlug: 'CASE-A',
    permissions: permissions as never,
    sessionId,
    writeSink: sink,
    network
  })

it('exposes only granted write verbs', () => {
  const b = bind(['sendToAgent'], 1)
  expect(typeof b.sendToAgent).toBe('function')
  expect(b.emitFinding).toBeUndefined()
  expect(b.cite).toBeUndefined()
})

it('omits write verbs when no sink is supplied', () => {
  const b = createPanelBridge({
    db,
    argusHome: home,
    caseSlug: 'CASE-A',
    permissions: ['sendToAgent', 'cite'] as never,
    sessionId: 1
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
  const res = await b.ingestEvidence!({
    source: { bytes: new Uint8Array([1, 2, 3]) },
    filename: 'a.bin'
  })
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

it('ingestEvidence: rejects a path-traversal filename without calling the sink', async () => {
  const b = bind(['ingestEvidence'], 4)
  const res = await b.ingestEvidence!({
    source: { bytes: new Uint8Array([1, 2, 3]) },
    filename: '../../etc/passwd'
  })
  expect(res).toEqual({ ok: false, reason: 'invalid-filename' })
  expect(calls).toEqual([])
})

it('ingestEvidence: rejects filenames containing a path separator or bare ".."', async () => {
  const b = bind(['ingestEvidence'], 4)
  const nested = await b.ingestEvidence!({
    source: { bytes: new Uint8Array([1]) },
    filename: 'a/b.txt'
  })
  expect(nested).toEqual({ ok: false, reason: 'invalid-filename' })

  const dotdot = await b.ingestEvidence!({
    source: { bytes: new Uint8Array([1]) },
    filename: '..'
  })
  expect(dotdot).toEqual({ ok: false, reason: 'invalid-filename' })
  expect(calls).toEqual([])
})

it('sendImageToAgent: is present only when granted', () => {
  expect(bind(['ingestEvidence'], 4).sendImageToAgent).toBeUndefined()
  expect(typeof bind(['sendImageToAgent'], 4).sendImageToAgent).toBe('function')
})

it('sendImageToAgent: routes bytes + filename + caption to the sink with bound case+session', async () => {
  const b = bind(['sendImageToAgent'], 4)
  const res = await b.sendImageToAgent!({
    bytes: new Uint8Array([1, 2, 3, 4]),
    filename: 'chart.png',
    caption: 'accuracy spikes'
  })
  expect(res).toEqual({ ok: true, evidenceId: '77' })
  expect(calls).toEqual(['image:CASE-A:4:chart.png:4:accuracy spikes'])
})

it('sendImageToAgent: caption is optional', async () => {
  const b = bind(['sendImageToAgent'], 4)
  const res = await b.sendImageToAgent!({ bytes: new Uint8Array([9]), filename: 'x.png' })
  expect(res).toEqual({ ok: true, evidenceId: '77' })
  expect(calls).toEqual(['image:CASE-A:4:x.png:1:'])
})

it('sendImageToAgent: rejects an oversized image without calling the sink', async () => {
  const b = bind(['sendImageToAgent'], 4)
  const big = new Uint8Array(25 * 1024 * 1024 + 1)
  const res = await b.sendImageToAgent!({ bytes: big, filename: 'big.png' })
  expect(res).toEqual({ ok: false, reason: 'bytes-too-large' })
  expect(calls).toEqual([])
})

it('sendImageToAgent: rejects a path-separator/traversal filename without calling the sink', async () => {
  const b = bind(['sendImageToAgent'], 4)
  expect(await b.sendImageToAgent!({ bytes: new Uint8Array([1]), filename: 'a/b.png' })).toEqual({
    ok: false,
    reason: 'invalid-filename'
  })
  expect(await b.sendImageToAgent!({ bytes: new Uint8Array([1]), filename: '..' })).toEqual({
    ok: false,
    reason: 'invalid-filename'
  })
  expect(calls).toEqual([])
})

it('sendImageToAgent: rejects an over-long caption without calling the sink', async () => {
  const b = bind(['sendImageToAgent'], 4)
  const res = await b.sendImageToAgent!({
    bytes: new Uint8Array([1]),
    filename: 'x.png',
    caption: 'z'.repeat(2001)
  })
  expect(res).toEqual({ ok: false, reason: 'caption-too-long' })
  expect(calls).toEqual([])
})

it('sendImageToAgent: throws when used with no bound session', async () => {
  const b = bind(['sendImageToAgent'], null)
  await expect(
    b.sendImageToAgent!({ bytes: new Uint8Array([1]), filename: 'x.png' })
  ).rejects.toThrow(/no bound session/)
})

it('sendImageToAgent: omitted when no sink is supplied even if granted', () => {
  const b = createPanelBridge({
    db,
    argusHome: home,
    caseSlug: 'CASE-A',
    permissions: ['sendImageToAgent'] as never,
    sessionId: 1
  })
  expect(b.sendImageToAgent).toBeUndefined()
})
