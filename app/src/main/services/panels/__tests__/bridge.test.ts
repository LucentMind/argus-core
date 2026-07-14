import { describe, it, expect, beforeEach } from 'vitest'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import type { DatabaseSync } from 'node:sqlite'
import { openDb } from '../../db'
import { createCase } from '../../caseService'
import { ingestArtifact, ingestDerived } from '../../ingest'
import { createDetection } from '../../packs/detection'
import { readEvidenceText } from '../../search'
import { createPanelBridge } from '../bridge'
import { caseDir } from '../../paths'

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

const bind = (
  caseSlug: string,
  permissions: Parameters<typeof createPanelBridge>[0]['permissions']
): ReturnType<typeof createPanelBridge> =>
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

  it('readCaseFiles is accepted but produces no bridge verb (protocol-only permission)', () => {
    const b = bind('CASE-A', ['readCaseFiles'])
    expect(b).toEqual({})
  })
})

describe('listCaseEvidence (3d-3)', () => {
  it('is absent when not granted', () => {
    expect(bind('CASE-A', ['requestEvidence']).listCaseEvidence).toBeUndefined()
  })

  it('is scoped to the bound case (not all cases)', () => {
    // beforeEach seeds exactly one item per case; a bound call must return only its own.
    expect(bind('CASE-A', ['listCaseEvidence']).listCaseEvidence!().length).toBe(1)
    expect(bind('CASE-B', ['listCaseEvidence']).listCaseEvidence!().length).toBe(1)
  })

  it('projects to the summary shape (no sha256/caseId/meta leak)', () => {
    const items = bind('CASE-B', ['listCaseEvidence']).listCaseEvidence!()
    expect(items.length).toBe(1)
    const item = items[0]
    expect(Object.keys(item).sort()).toEqual(
      ['artifactType', 'createdAt', 'evidenceId', 'origin', 'relPath', 'size'].sort()
    )
    expect(item).not.toHaveProperty('sha256')
    expect(item).not.toHaveProperty('caseId')
    expect(item).not.toHaveProperty('meta')
    expect(typeof item.evidenceId).toBe('number')
    expect(item.relPath).toMatch(/^evidence\//)
  })

  it('lifts meta.derivedFrom into a top-level derivedFrom', () => {
    const parent = bind('CASE-A', ['listCaseEvidence']).listCaseEvidence!()[0]
    const derivedDir = path.join(caseDir(home, 'CASE-A'), 'evidence', '.derived')
    fs.mkdirSync(derivedDir, { recursive: true })
    const abs = path.join(derivedDir, 'note.txt')
    fs.writeFileSync(abs, 'derived text')
    const derivedRec = ingestDerived(db, home, 'CASE-A', abs, parent.evidenceId)

    const items = bind('CASE-A', ['listCaseEvidence']).listCaseEvidence!()
    const derived = items.find((e) => e.evidenceId === derivedRec.id)!
    expect(derived.derivedFrom).toBe(parent.evidenceId)
    const original = items.find((e) => e.evidenceId === parent.evidenceId)!
    expect(original.derivedFrom).toBeUndefined()
  })
})
