import { describe, it, expect, beforeEach } from 'vitest'
import { DatabaseSync } from 'node:sqlite'
import { openDb } from '../db'
import { createCase } from '../caseService'
import { modeContextForCase } from '../modeContext'
import { availableModes } from '../../../shared/modes'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

let db: DatabaseSync
beforeEach(() => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'argus-ctx-'))
  db = openDb(path.join(home, 'argus.db'))
  createCase(db, home, { slug: 'c1', title: 'Case' })
})

describe('modeContextForCase', () => {
  it('reports zero linked PRs until Plan 2 populates them, so only investigation is available', () => {
    const ctx = modeContextForCase(db, 'c1')
    expect(ctx.linkedPrCount).toBe(0)
    expect(availableModes(ctx)).toEqual(['investigation'])
  })
})
