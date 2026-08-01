import { it, expect, beforeEach, afterEach, describe } from 'vitest'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import type { DatabaseSync } from 'node:sqlite'
import { openDb } from '../../db'
import { createCase, getCase } from '../../caseService'
import { createDetection } from '../../packs/detection'
import { argusToolHandlers } from '../nativeTools'

let home: string
let db: DatabaseSync
let handlers: Record<string, (args: Record<string, unknown>) => Promise<string>>

beforeEach(() => {
  home = fs.mkdtempSync(path.join(os.tmpdir(), 'argus-status-'))
  db = openDb(path.join(home, 'argus.db'))
  const rec = createCase(db, home, { slug: 'NAV-1', title: 'Bearing jumps' })
  handlers = argusToolHandlers({
    db,
    argusHome: home,
    detection: createDetection(),
    caseId: rec.id,
    caseSlug: 'NAV-1',
    sessionId: 1,
    // Required by NativeToolDeps; no assertion here reaches a finding-writing tool.
    emitFinding: () => {}
  })
})

afterEach(() => {
  db.close()
  fs.rmSync(home, { recursive: true, force: true })
})

describe('update_case_status', () => {
  it('closes a case through the lifecycle writer', async () => {
    const out = await handlers.update_case_status({ status: 'closed', resolution: 'solved' })
    expect(out).toContain('closed')
    expect(getCase(db, 'NAV-1')!.status).toBe('closed')
    expect(getCase(db, 'NAV-1')!.phase).toBe('closed')
  })

  it('routes rca-drafted to a pin instead of the lifecycle', async () => {
    await handlers.update_case_status({ status: 'rca-drafted' })
    expect(getCase(db, 'NAV-1')!.status).toBe('open')
    expect(getCase(db, 'NAV-1')!.phase).toBe('rca-drafted')
  })

  it('rejects a derived phase with an explanation', async () => {
    for (const status of ['analyzing', 'pr-created', 'reviewing']) {
      await expect(handlers.update_case_status({ status })).rejects.toThrow(/derived/i)
    }
  })

  it('still requires a resolution when closing', async () => {
    await expect(handlers.update_case_status({ status: 'closed' })).rejects.toThrow()
  })

  it('rejects a value that is not a phase at all', async () => {
    await expect(handlers.update_case_status({ status: 'banana' })).rejects.toThrow()
  })
})
