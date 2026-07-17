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
import { __clearIndexCacheForTests } from '../lineIndex'
import type { TextDocSearchEvent } from '../../../shared/textdoc'

let tmp: string, argusHome: string, db: DatabaseSync, evidenceId: number
const detection = createDetection()

beforeEach(() => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'argus-th-'))
  argusHome = path.join(tmp, 'home')
  db = openDb(path.join(argusHome, 'argus.db'))
  createCase(db, argusHome, { slug: 'NAV-2', title: 't' })
  const src = path.join(tmp, 'log.txt')
  fs.writeFileSync(src, Array.from({ length: 5000 }, (_, i) => (i % 100 === 0 ? `ERROR ${i}` : `info ${i}`)).join('\n') + '\n')
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
    await hub.start('s1', { kind: 'evidence', evidenceId }, 'ERROR', {})
    const all = events.flatMap((e) => e.hits)
    expect(all).toHaveLength(50)
    expect(all[0]).toBe(1) // i=0 is line 1
    expect(events[events.length - 1]).toMatchObject({ searchId: 's1', done: true, capped: false })
  })

  it('a new start cancels the previous search; cancelled searches emit no further events', async () => {
    const events: TextDocSearchEvent[] = []
    const hub = new TextDocSearchHub(db, argusHome, (e) => events.push(e))
    const first = hub.start('old', { kind: 'evidence', evidenceId }, 'info', {})
    await hub.start('new', { kind: 'evidence', evidenceId }, 'ERROR', {})
    await first
    const oldDone = events.filter((e) => e.searchId === 'old' && e.done)
    expect(oldDone).toHaveLength(0) // aborted, never completed
    expect(events.some((e) => e.searchId === 'new' && e.done)).toBe(true)
  })

  it('cancel(searchId) stops an in-flight search', async () => {
    const events: TextDocSearchEvent[] = []
    const hub = new TextDocSearchHub(db, argusHome, (e) => events.push(e))
    const p = hub.start('s2', { kind: 'evidence', evidenceId }, 'info', {})
    hub.cancel('s2')
    await p
    expect(events.filter((e) => e.searchId === 's2' && e.done)).toHaveLength(0)
  })
})
