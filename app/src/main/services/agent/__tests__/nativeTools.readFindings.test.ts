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

  // Seed finding 1 through the actual append_finding tool (not the low-level appendFinding
  // helper) so diff_path/diff_line come from a real citation and suggested_change is a real
  // tool arg — proving the assertions below exercise the handler's meta-line rendering, not
  // body prose that merely happens to contain the same words.
  await handlers.append_finding({
    title: 'Race in parser',
    markdown:
      'Concurrent readers can observe a torn buffer while [src/a.ts:3] mutates it mid-parse.',
    layer: 'correctness',
    severity: 'major',
    suggested_change: 'use the safe parser'
  })
  const seeded1 = db.prepare(`SELECT id FROM findings ORDER BY id DESC LIMIT 1`).get() as {
    id: number
  }
  const id1 = seeded1.id

  const appendCtx: FindingWriteCtx = {
    db,
    argusHome: home,
    caseId,
    caseSlug: 'CASE-A',
    sessionId: 5,
    turnId: null
  }
  const { findingId: id2 } = appendFinding(appendCtx, {
    title: 'Null deref',
    markdown: 'Body of second finding'
  })

  const out = await handlers.read_findings({ finding_ids: [id1, id2] })

  expect(out).toContain(`## Finding ${id1}`)
  expect(out).toContain('severity: major')
  expect(out).toContain('layer: correctness')
  expect(out).toContain('anchor: src/a.ts:3')
  expect(out).toContain('Suggested change: use the safe parser')
  expect(out).toContain('Concurrent readers can observe a torn buffer')
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

it('rejects a non-integer id with the same at-least-one-finding-id error', async () => {
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
  await expect(handlers.read_findings({ finding_ids: [1.5] })).rejects.toThrow(
    /at least one finding id/i
  )
})
