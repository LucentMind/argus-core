import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { appendDeletionAudit, readDeletionAudit } from '../deletionAudit'
import { deletionAuditPath } from '../paths'

let tmp: string

beforeEach(() => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'argus-audit-'))
})
afterEach(() => {
  fs.rmSync(tmp, { recursive: true, force: true })
})

describe('deletionAudit', () => {
  it('creates the .audit dir on first write and appends one JSON line per entry', () => {
    appendDeletionAudit(tmp, 'findings.clear', 'NAV-1', { cleared: 3 })
    appendDeletionAudit(tmp, 'session.delete', 'NAV-1', { sessionId: 7 })
    const lines = fs.readFileSync(deletionAuditPath(tmp), 'utf8').trim().split('\n')
    expect(lines).toHaveLength(2)
    const entries = readDeletionAudit(tmp)
    expect(entries[0]).toMatchObject({
      op: 'findings.clear',
      caseSlug: 'NAV-1',
      detail: { cleared: 3 }
    })
    expect(entries[1].op).toBe('session.delete')
    expect(entries[0].ts).toMatch(/^\d{4}-\d{2}-\d{2}T/)
  })

  it('readDeletionAudit returns [] when no journal exists', () => {
    expect(readDeletionAudit(tmp)).toEqual([])
  })
})
