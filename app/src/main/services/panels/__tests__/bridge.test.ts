import { describe, it, expect, beforeEach } from 'vitest'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import type { DatabaseSync } from 'node:sqlite'
import { openDb } from '../../db'
import { createCase } from '../../caseService'
import { ingestArtifact } from '../../ingest'
import { createDetection } from '../../packs/detection'
import { readEvidenceText } from '../../search'
import { createPanelBridge } from '../bridge'

const FIXTURE = path.resolve(__dirname, '../../../../../../tests/fixtures/sample-applog.txt')
const detection = createDetection()
let home: string
let db: DatabaseSync

beforeEach(() => {
  home = fs.mkdtempSync(path.join(os.tmpdir(), 'argus-panel-bridge-'))
  db = openDb(path.join(home, 'argus.db'))
  createCase(db, home, { slug: 'CASE-A', title: 'A' })
  createCase(db, home, { slug: 'CASE-B', title: 'B' })
  ingestArtifact(db, home, detection, 'CASE-A', FIXTURE)
  ingestArtifact(db, home, detection, 'CASE-B', FIXTURE)
})

const bind = (caseSlug: string, permissions: Parameters<typeof createPanelBridge>[0]['permissions']) =>
  createPanelBridge({ db, argusHome: home, caseSlug, permissions })

describe('createPanelBridge', () => {
  it('exposes only granted verbs (ungranted are absent)', () => {
    const only = bind('CASE-A', ['readEvidence'])
    expect(typeof only.readEvidence).toBe('function')
    expect(only.getCaseContext).toBeUndefined()
    expect(only.requestEvidence).toBeUndefined()
  })

  it('getCaseContext returns the bound case id/slug + focus + session', () => {
    const b = createPanelBridge({
      db,
      argusHome: home,
      caseSlug: 'CASE-A',
      permissions: ['getCaseContext'],
      focus: { evidenceId: 7, line: 42 },
      sessionId: 3
    })
    const ctx = b.getCaseContext!()
    expect(ctx.caseSlug).toBe('CASE-A')
    expect(typeof ctx.caseId).toBe('number')
    expect(ctx.sessionId).toBe(3)
    expect(ctx.focus).toEqual({ evidenceId: 7, line: 42 })
  })

  it('requestEvidence is scoped to the bound case only', () => {
    const hits = bind('CASE-B', ['requestEvidence']).requestEvidence!('TileStore')
    expect(hits.length).toBeGreaterThan(0)
    expect(hits.every((h) => h.caseSlug === 'CASE-B')).toBe(true)
  })

  it('readEvidence returns the text content of an in-case item', () => {
    const aBridge = bind('CASE-A', ['requestEvidence', 'readEvidence'])
    const [hit] = aBridge.requestEvidence!('NoRoute')
    const doc = aBridge.readEvidence!(hit.evidenceId)
    expect(doc.caseSlug).toBe('CASE-A')
    expect(doc.content).toContain('Router error: NoRoute')
  })

  it('readEvidence rejects an evidence id from a DIFFERENT case (case-binding)', () => {
    const [bHit] = bind('CASE-B', ['requestEvidence']).requestEvidence!('TileStore')
    expect(readEvidenceText(db, home, bHit.evidenceId).caseSlug).toBe('CASE-B') // sanity
    const aBridge = bind('CASE-A', ['readEvidence'])
    expect(() => aBridge.readEvidence!(bHit.evidenceId)).toThrow(/CASE-A|not in case/)
  })
})
