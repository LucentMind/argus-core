import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { openDb } from '../../db'
import { createCase } from '../../caseService'
import { ingestArtifact } from '../../ingest'
import { argusToolHandlers } from '../nativeTools'
import { agentAccessSchema } from '../../../../shared/agentAccess'
import type { DatabaseSync } from 'node:sqlite'

let tmp: string, argusHome: string, db: DatabaseSync
let handlers: ReturnType<typeof argusToolHandlers>
const emitFinding = vi.fn()

beforeEach(() => {
  emitFinding.mockClear()
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'argus-nt-'))
  argusHome = path.join(tmp, 'home')
  db = openDb(path.join(argusHome, 'argus.db'))
  const rec = createCase(db, argusHome, { slug: 'NAV-1', title: 't' })
  const src = path.join(tmp, 'log.txt')
  fs.writeFileSync(src, 'FATAL Navigator crashed at tile load\nline two\n')
  ingestArtifact(db, argusHome, 'NAV-1', src)
  handlers = argusToolHandlers({
    db,
    argusHome,
    caseId: rec.id,
    caseSlug: 'NAV-1',
    sessionId: 1,
    emitFinding
  })
})

afterEach(() => {
  db.close()
  fs.rmSync(tmp, { recursive: true, force: true })
})

describe('argus native tools', () => {
  it('search_evidence returns citation-ready hits', async () => {
    const out = await handlers.search_evidence({ query: 'Navigator crashed' })
    const hits = JSON.parse(out)
    expect(hits[0]).toMatchObject({ relPath: 'evidence/log.txt', matchLine: 1 })
  })

  it('list_evidence inventories the case', async () => {
    const out = JSON.parse(await handlers.list_evidence({}))
    expect(out).toHaveLength(1)
    expect(out[0].artifactType).toBe('text')
  })

  it('ingest_artifact registers a derived file and refuses paths outside the case dir', async () => {
    const derived = path.join(argusHome, 'cases', 'NAV-1', 'converted.txt')
    fs.writeFileSync(derived, 'derived text\n')
    const rec = JSON.parse(await handlers.ingest_artifact({ path: derived }))
    expect(rec.relPath).toBe('evidence/converted.txt')
    expect(rec.origin).toBe('agent')
    await expect(handlers.ingest_artifact({ path: '/etc/hosts' })).rejects.toThrow(/case dir/i)
  })

  it('append_finding writes findings.md and emits', async () => {
    await handlers.append_finding({
      title: 'Tile crash',
      markdown: 'Crash at [evidence/log.txt:1]'
    })
    const findings = fs.readFileSync(path.join(argusHome, 'cases', 'NAV-1', 'findings.md'), 'utf8')
    expect(findings).toContain('## Tile crash')
    expect(findings).toContain('[evidence/log.txt:1]')
    expect(emitFinding).toHaveBeenCalledOnce()
  })

  it('update_case_status validates and persists', async () => {
    await handlers.update_case_status({ status: 'analyzing' })
    const row = db.prepare(`SELECT status FROM cases WHERE slug='NAV-1'`).get() as {
      status: string
    }
    expect(row.status).toBe('analyzing')
    await expect(handlers.update_case_status({ status: 'bogus' })).rejects.toThrow(/status/i)
  })

  it('read_memory returns an enabled topic body', async () => {
    await handlers.write_memory({ topic: 'binder-crashes', content: 'check binder pool first' })
    const out = await handlers.read_memory({ topic: 'binder-crashes' })
    expect(out).toContain('check binder pool first')
  })

  it('read_memory refuses a disabled topic', async () => {
    await handlers.write_memory({ topic: 'binder-crashes', content: 'check binder pool first' })
    const gated = argusToolHandlers({
      db,
      argusHome,
      caseId: 1,
      caseSlug: 'NAV-1',
      sessionId: 1,
      emitFinding,
      agentAccess: () => agentAccessSchema.parse({ memory: { 'binder-crashes': false } })
    })
    await expect(gated.read_memory({ topic: 'binder-crashes' })).rejects.toThrow(/disabled/i)
  })

  it('read_memory rejects _index and unknown topics', async () => {
    await expect(handlers.read_memory({ topic: '_index' })).rejects.toThrow(/not a topic/i)
    await expect(handlers.read_memory({ topic: 'nope' })).rejects.toThrow(/no such topic/i)
  })

  it('write_memory appends topic content, index line, and audit entry', async () => {
    const out = await handlers.write_memory({
      topic: 'binder-crashes',
      content: 'VHAL binder crashes: check the binder thread pool first.',
      index_entry: 'VHAL/binder crash triage order'
    })
    expect(out).toContain('binder-crashes')
    const idx = fs.readFileSync(path.join(argusHome, 'memory', '_index.md'), 'utf8')
    expect(idx).toContain('- [binder-crashes](binder-crashes.md) — VHAL/binder crash triage order')
    const topic = fs.readFileSync(path.join(argusHome, 'memory', 'binder-crashes.md'), 'utf8')
    expect(topic).toContain('binder thread pool')
  })
})
