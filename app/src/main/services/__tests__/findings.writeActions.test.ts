import { describe, it, expect, beforeEach } from 'vitest'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import type { DatabaseSync } from 'node:sqlite'
import { openDb } from '../db'
import { createCase, getCase } from '../caseService'
import { listFindings, recordFindingWrite } from '../findings'
import { appendFinding, type FindingWriteCtx } from '../agent/nativeTools'

let db: DatabaseSync
let home: string
let caseId: number

beforeEach(() => {
  home = fs.mkdtempSync(path.join(os.tmpdir(), 'argus-findwrite-'))
  db = openDb(path.join(home, 'argus.db'))
  createCase(db, home, { slug: 'c1', title: 'Case 1' })
  caseId = getCase(db, 'c1')!.id
})

const ctx = (): FindingWriteCtx => ({
  db,
  argusHome: home,
  caseId,
  caseSlug: 'c1',
  sessionId: 1,
  turnId: null
})

describe('appendFinding suggested change', () => {
  it('stores the suggested change and reads it back on the row', () => {
    const { findingId } = appendFinding(ctx(), {
      title: 'Inverted guard',
      markdown: 'The guard is inverted. See [widget/src/guard.ts:17].',
      layer: 'correctness',
      severity: 'major',
      suggestedChange: 'Flip the condition to `if (!ok) return`.'
    })
    const row = listFindings(db, home, 'c1').find((f) => f.id === findingId)
    expect(row?.suggestedChange).toBe('Flip the condition to `if (!ok) return`.')
    expect(row?.commentUrl).toBeNull()
    expect(row?.pushedSha).toBeNull()
  })

  it('leaves the column null when the caller omits it', () => {
    const { findingId } = appendFinding(ctx(), { title: 'Plain', markdown: 'no fix offered' })
    const row = listFindings(db, home, 'c1').find((f) => f.id === findingId)
    expect(row?.suggestedChange).toBeNull()
  })
})

describe('recordFindingWrite', () => {
  it('records a comment url without disturbing the push column', () => {
    const { findingId } = appendFinding(ctx(), { title: 'F', markdown: 'x' })
    recordFindingWrite(db, findingId, { commentUrl: 'https://github.com/a/b/pull/1#d_r5' })
    const row = listFindings(db, home, 'c1').find((f) => f.id === findingId)
    expect(row?.commentUrl).toBe('https://github.com/a/b/pull/1#d_r5')
    expect(row?.pushedSha).toBeNull()
  })

  it('records a pushed sha without disturbing the comment column', () => {
    const { findingId } = appendFinding(ctx(), { title: 'F', markdown: 'x' })
    recordFindingWrite(db, findingId, { commentUrl: 'https://u' })
    recordFindingWrite(db, findingId, { pushedSha: 'deadbee' })
    const row = listFindings(db, home, 'c1').find((f) => f.id === findingId)
    expect(row?.commentUrl).toBe('https://u')
    expect(row?.pushedSha).toBe('deadbee')
  })

  it('is a no-op when the patch is empty', () => {
    const { findingId } = appendFinding(ctx(), { title: 'F', markdown: 'x' })
    expect(() => recordFindingWrite(db, findingId, {})).not.toThrow()
    const row = listFindings(db, home, 'c1').find((f) => f.id === findingId)
    expect(row?.commentUrl).toBeNull()
  })
})
