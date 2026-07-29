import { it, expect, beforeEach, afterEach } from 'vitest'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import type { DatabaseSync } from 'node:sqlite'
import { openDb } from '../../db'
import { createCase } from '../../caseService'
import { appendFinding, type FindingWriteCtx, argusToolHandlers, type NativeToolDeps } from '../nativeTools'
import type { Detection } from '../../packs/detection'

let home: string, db: DatabaseSync, caseId: number, otherCaseId: number

beforeEach(() => {
  home = fs.mkdtempSync(path.join(os.tmpdir(), 'argus-finding-'))
  db = openDb(path.join(home, 'argus.db'))
  const c1 = createCase(db, home, { slug: 'CASE-A', title: 'A' })
  const c2 = createCase(db, home, { slug: 'CASE-B', title: 'B' })
  caseId = c1.id
  otherCaseId = c2.id
})

afterEach(() => {
  db.close()
  fs.rmSync(home, { recursive: true, force: true })
})

it('returns summary, meta and findings.md body per id', async () => {
  const appendCtx: FindingWriteCtx = {
    db,
    argusHome: home,
    caseId,
    caseSlug: 'CASE-A',
    sessionId: 5,
    turnId: null
  }

  // Seed two findings
  const { findingId: id1 } = appendFinding(appendCtx, {
    title: 'Race in parser',
    markdown: 'Suggested change: use the safe parser\n\nthe markdown body recorded for id1',
    layer: 'correctness',
    severity: 'major'
  })

  const { findingId: id2 } = appendFinding(appendCtx, {
    title: 'Null deref',
    markdown: 'Body of second finding'
  })

  // Create handlers with a mock Detection
  const mockDetection = {} as Detection
  const toolDeps: NativeToolDeps = {
    db,
    argusHome: home,
    detection: mockDetection,
    caseId,
    caseSlug: 'CASE-A',
    sessionId: 5,
    emitFinding: () => {}
  }

  const handlers = argusToolHandlers(toolDeps)
  const out = await handlers.read_findings({ finding_ids: [id1, id2] })

  expect(out).toContain(`## Finding ${id1}`)
  expect(out).toContain('severity: major')
  expect(out).toContain('layer: correctness')
  expect(out).toContain('the markdown body recorded for id1')
  expect(out).toContain(`## Finding ${id2}`)
})

it('rejects an id from another case with the opaque unknown-finding error', async () => {
  const appendCtx: FindingWriteCtx = {
    db,
    argusHome: home,
    caseId: otherCaseId,
    caseSlug: 'CASE-B',
    sessionId: 5,
    turnId: null
  }

  // Append a finding to the OTHER case
  const { findingId: otherCaseFindingId } = appendFinding(appendCtx, {
    title: 'Other case finding',
    markdown: 'Body'
  })

  // Try to read it from CASE-A
  const mockDetection = {} as Detection
  const toolDeps: NativeToolDeps = {
    db,
    argusHome: home,
    detection: mockDetection,
    caseId,
    caseSlug: 'CASE-A',
    sessionId: 5,
    emitFinding: () => {}
  }

  const handlers = argusToolHandlers(toolDeps)
  await expect(handlers.read_findings({ finding_ids: [otherCaseFindingId] })).rejects.toThrow(
    'Unknown finding id.'
  )
})

it('rejects an empty id list', async () => {
  const mockDetection = {} as Detection
  const toolDeps: NativeToolDeps = {
    db,
    argusHome: home,
    detection: mockDetection,
    caseId,
    caseSlug: 'CASE-A',
    sessionId: 5,
    emitFinding: () => {}
  }

  const handlers = argusToolHandlers(toolDeps)
  await expect(handlers.read_findings({ finding_ids: [] })).rejects.toThrow(/at least one finding id/i)
})
