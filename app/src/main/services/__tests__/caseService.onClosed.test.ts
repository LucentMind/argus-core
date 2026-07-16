import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { describe, it, expect, beforeEach, vi } from 'vitest'
import type { DatabaseSync } from 'node:sqlite'
import { openDb } from '../db'
import { createCase, setCaseStatus } from '../caseService'

let home: string
let db: DatabaseSync
beforeEach(() => {
  home = fs.mkdtempSync(path.join(os.tmpdir(), 'argus-home-'))
  db = openDb(path.join(home, 'argus.db'))
  createCase(db, home, { slug: 'c1', title: 'T' })
})

describe('setCaseStatus onClosed hook', () => {
  it('fires once on open→closed with the updated record', () => {
    const hook = vi.fn()
    const rec = setCaseStatus(db, home, 'c1', 'closed', 'solved', hook)
    expect(hook).toHaveBeenCalledExactlyOnceWith(
      expect.objectContaining({ slug: 'c1', status: 'closed' })
    )
    expect(rec.resolution).toBe('solved')
  })

  it('does not fire on non-close transitions or re-close', () => {
    const hook = vi.fn()
    setCaseStatus(db, home, 'c1', 'analyzing', null, hook)
    expect(hook).not.toHaveBeenCalled()
    setCaseStatus(db, home, 'c1', 'closed', 'solved')
    setCaseStatus(db, home, 'c1', 'closed', 'wont-fix', hook) // already closed → no re-fire
    expect(hook).not.toHaveBeenCalled()
  })

  it('a throwing hook never fails the close', () => {
    const rec = setCaseStatus(db, home, 'c1', 'closed', 'solved', () => {
      throw new Error('boom')
    })
    expect(rec.status).toBe('closed')
  })
})
