import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import type { DatabaseSync } from 'node:sqlite'
import { openDb } from '../db'
import { createCase } from '../caseService'
import { ingestArtifact } from '../ingest'
import { createDetection } from '../packs/detection'
import { TextDocSearchHub } from '../textdocSearch'
import { __clearIndexCacheForTests, sidecarPath } from '../lineIndex'
import type { TextDocSearchEvent } from '../../../shared/textdoc'

let tmp: string, argusHome: string, db: DatabaseSync, evidenceId: number
const detection = createDetection()

beforeEach(() => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'argus-th-'))
  argusHome = path.join(tmp, 'home')
  db = openDb(path.join(argusHome, 'argus.db'))
  createCase(db, argusHome, { slug: 'NAV-2', title: 't' })
  const src = path.join(tmp, 'log.txt')
  fs.writeFileSync(
    src,
    Array.from({ length: 5000 }, (_, i) => (i % 100 === 0 ? `ERROR ${i}` : `info ${i}`)).join(
      '\n'
    ) + '\n'
  )
  evidenceId = ingestArtifact(db, argusHome, detection, 'NAV-2', src).id
  __clearIndexCacheForTests()
})
afterEach(() => {
  db.close()
  fs.rmSync(tmp, { recursive: true, force: true })
})

describe('TextDocSearchHub', () => {
  it('streams hits and a final done event', async () => {
    const events: TextDocSearchEvent[] = []
    const hub = new TextDocSearchHub(db, argusHome, (e) => events.push(e))
    await hub.start('e:1:fnd:1', { kind: 'evidence', evidenceId }, 'ERROR', {})
    const all = events.flatMap((e) => e.hits)
    expect(all).toHaveLength(50)
    expect(all[0]).toBe(1) // i=0 is line 1
    expect(events[events.length - 1]).toMatchObject({
      searchId: 'e:1:fnd:1',
      done: true,
      capped: false
    })
  })

  it('a new start cancels the previous search; cancelled searches emit no further events', async () => {
    const events: TextDocSearchEvent[] = []
    const hub = new TextDocSearchHub(db, argusHome, (e) => events.push(e))
    const first = hub.start('e:1:fnd:1', { kind: 'evidence', evidenceId }, 'info', {})
    await hub.start('e:1:fnd:2', { kind: 'evidence', evidenceId }, 'ERROR', {})
    await first
    const oldDone = events.filter((e) => e.searchId === 'e:1:fnd:1' && e.done)
    expect(oldDone).toHaveLength(0) // aborted, never completed
    expect(events.some((e) => e.searchId === 'e:1:fnd:2' && e.done)).toBe(true)
  })

  it('cancel(searchId) stops an in-flight search', async () => {
    const events: TextDocSearchEvent[] = []
    const hub = new TextDocSearchHub(db, argusHome, (e) => events.push(e))
    const p = hub.start('e:1:fnd:2', { kind: 'evidence', evidenceId }, 'info', {})
    hub.cancel('e:1:fnd:2')
    await p
    expect(events.filter((e) => e.searchId === 'e:1:fnd:2' && e.done)).toHaveLength(0)
  })

  it('flt and fnd channels coexist; restarting one does not cancel the other', async () => {
    const events: TextDocSearchEvent[] = []
    const hub = new TextDocSearchHub(db, argusHome, (e) => events.push(e))
    const flt = hub.start('e:1:flt:1', { kind: 'evidence', evidenceId }, 'info', {})
    const fnd = hub.start('e:1:fnd:1', { kind: 'evidence', evidenceId }, 'ERROR', {})
    await Promise.all([flt, fnd])
    expect(events.some((e) => e.searchId === 'e:1:flt:1' && e.done)).toBe(true)
    expect(events.some((e) => e.searchId === 'e:1:fnd:1' && e.done)).toBe(true)
    // restart fnd only — flt is NOT cancelled
    const flt2 = hub.start('e:1:flt:2', { kind: 'evidence', evidenceId }, 'info', {})
    await hub.start('e:1:fnd:2', { kind: 'evidence', evidenceId }, 'ERROR', {})
    await flt2
    expect(events.some((e) => e.searchId === 'e:1:flt:2' && e.done)).toBe(true)
  })

  it('unresolvable source and invalid regex both settle with a terminal empty event', async () => {
    const events: TextDocSearchEvent[] = []
    const hub = new TextDocSearchHub(db, argusHome, (e) => events.push(e))
    await hub.start('e:404:fnd:1', { kind: 'evidence', evidenceId: 424242 }, 'x', {})
    expect(events).toEqual([
      { searchId: 'e:404:fnd:1', hits: [], scannedTo: 0, done: true, capped: false }
    ])
    events.length = 0
    await hub.start('e:1:fnd:9', { kind: 'evidence', evidenceId }, '[', { regex: true })
    expect(events).toEqual([
      { searchId: 'e:1:fnd:9', hits: [], scannedTo: 0, done: true, capped: false }
    ])
  })

  it('forwards index-build progress for a lazy rebuild triggered by search', async () => {
    // simulate a stale index: remove the sidecar and drop the memory cache so
    // the hub's ensureIndex must rebuild from scratch
    const abs = path.join(argusHome, 'cases', 'NAV-2', 'evidence', 'log.txt')
    fs.rmSync(sidecarPath(argusHome, abs), { force: true })
    __clearIndexCacheForTests()
    const progress: Array<{ key: string; fraction: number }> = []
    const hub = new TextDocSearchHub(
      db,
      argusHome,
      () => undefined,
      (p) => progress.push(p)
    )
    await hub.start('e:1:fnd:2', { kind: 'evidence', evidenceId }, 'ERROR', {})
    expect(progress.length).toBeGreaterThan(0)
    expect(progress[progress.length - 1]).toEqual({ key: `e:${evidenceId}`, fraction: 1 })
  })

  it('passes the filter option through to the engine', async () => {
    const events: TextDocSearchEvent[] = []
    const hub = new TextDocSearchHub(db, argusHome, (e) => events.push(e))
    await hub.start('e:1:fnd:9', { kind: 'evidence', evidenceId }, 'info', {
      filter: { query: 'ERROR' }
    })
    // fixture: every 100th line is `ERROR ${i}`, others `info ${i}` — nothing matches both
    expect(events.flatMap((e) => e.hits)).toHaveLength(0)
    expect(events[events.length - 1].done).toBe(true)
  })
})
