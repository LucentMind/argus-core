import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { z } from 'zod'
import { openDb } from '../../db'
import { createCase } from '../../caseService'
import { ingestArtifact } from '../../ingest'
import { createDetection } from '../../packs/detection'
import { createSession } from '../sessionStore'
import { argusToolHandlers, NATIVE_TOOL_SPECS } from '../nativeTools'
import { agentAccessSchema } from '../../../../shared/agentAccess'
import { MEMORY_SCOPES } from '../../../../shared/memoryScope'
import type { DatabaseSync } from 'node:sqlite'
import { createImmediateQueue } from '../../ingestQueue'
import { setIndexState } from '../../indexState'

/**
 * search_evidence's result is JSON followed by an optional advisory line (see the
 * handler's own comment). Splitting on the blank line that separates them keeps
 * JSON.parse working regardless of whether a note is present.
 */
function hitsOf(out: string): unknown[] {
  return JSON.parse(out.split('\n\n')[0])
}

let tmp: string, argusHome: string, db: DatabaseSync, caseId: number
let handlers: ReturnType<typeof argusToolHandlers>
const emitFinding = vi.fn()
const detection = createDetection()

beforeEach(async () => {
  emitFinding.mockClear()
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'argus-nt-'))
  argusHome = path.join(tmp, 'home')
  db = openDb(path.join(argusHome, 'argus.db'))
  const rec = createCase(db, argusHome, { slug: 'NAV-1', title: 't' })
  caseId = rec.id
  const src = path.join(tmp, 'log.txt')
  fs.writeFileSync(src, 'FATAL Navigator crashed at tile load\nline two\n')
  await ingestArtifact(db, argusHome, detection, createImmediateQueue(db, argusHome), 'NAV-1', src)
  handlers = argusToolHandlers({
    db,
    argusHome,
    detection,
    caseId: rec.id,
    caseSlug: 'NAV-1',
    sessionId: 1,
    emitFinding,
    githubWatermark: () => ({ enabled: false, text: '' })
  })
})

afterEach(() => {
  db.close()
  fs.rmSync(tmp, { recursive: true, force: true })
})

describe('argus native tools', () => {
  it('search_evidence returns citation-ready hits', async () => {
    const out = await handlers.search_evidence({ query: 'Navigator crashed' })
    const hits = hitsOf(out)
    expect(hits[0]).toMatchObject({ relPath: 'evidence/log.txt', matchLine: 1 })
  })

  it('search_evidence warns the model on a zero-hit query when a file is still indexing', async () => {
    // A second file, still 'pending': the query below matches nothing among the
    // fully-indexed evidence, which is exactly the case an agent must not read as
    // "the term is absent" — the whole point of this note.
    const src2 = path.join(tmp, 'other.txt')
    fs.writeFileSync(src2, 'unrelated content\n')
    const rec2 = await ingestArtifact(
      db,
      argusHome,
      detection,
      createImmediateQueue(db, argusHome),
      'NAV-1',
      src2
    )
    setIndexState(db, rec2.id, 'pending')

    const out = await handlers.search_evidence({ query: 'no_such_term_zzz' })
    expect(hitsOf(out)).toEqual([])
    expect(out).toContain(
      '1 file(s) in this case are still being indexed. These results may be incomplete'
    )
  })

  it("search_evidence's pending note says 'across all cases' when scope is 'all'", async () => {
    const rec2 = createCase(db, argusHome, { slug: 'NAV-2', title: 'other' })
    const src2 = path.join(tmp, 'nav2.txt')
    fs.writeFileSync(src2, 'nav2 content\n')
    await ingestArtifact(
      db,
      argusHome,
      detection,
      createImmediateQueue(db, argusHome),
      'NAV-2',
      src2
    )
    const nav2Evidence = db
      .prepare(`SELECT e.id AS id FROM evidence e WHERE e.case_id = ?`)
      .get(rec2.id) as { id: number }
    setIndexState(db, nav2Evidence.id, 'pending')

    const out = await handlers.search_evidence({ query: 'no_such_term_zzz', scope: 'all' })
    expect(out).toContain('1 file(s) across all cases are still being indexed')
    expect(out).not.toContain('in this case are still being indexed')
  })

  it('search_evidence separately notes permanently failed files, with different advice', async () => {
    const src2 = path.join(tmp, 'broken.txt')
    fs.writeFileSync(src2, 'broken content\n')
    const rec2 = await ingestArtifact(
      db,
      argusHome,
      detection,
      createImmediateQueue(db, argusHome),
      'NAV-1',
      src2
    )
    setIndexState(db, rec2.id, 'error')

    const out = await handlers.search_evidence({ query: 'no_such_term_zzz' })
    expect(out).toContain('1 file(s) in this case failed to index')
    expect(out).toContain('re-ingesting')
    expect(out).not.toContain('still being indexed')
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

  it('append_finding inserts a findings row with the current turn id', async () => {
    const withTurn = argusToolHandlers({
      db,
      argusHome,
      detection,
      caseId,
      caseSlug: 'NAV-1',
      sessionId: 1,
      emitFinding,
      currentTurnId: () => 42,
      githubWatermark: () => ({ enabled: false, text: '' })
    })
    await withTurn.append_finding({ title: 'Root cause X', markdown: 'details' })
    const row = db.prepare(`SELECT * FROM findings WHERE case_id = ?`).get(caseId) as {
      summary: string
      turn_id: number
      session_id: number
      review_state: string
    }
    expect(row.summary).toBe('Root cause X')
    expect(row.turn_id).toBe(42)
    expect(row.session_id).toBe(1)
    expect(row.review_state).toBe('pending')
  })

  it('update_case_status validates and persists', async () => {
    // 'analyzing' is now a derived phase (see nativeTools.caseStatus.test.ts) — exercise the
    // lifecycle round trip instead: close, then reopen, to prove a real write happens through
    // the tool rather than the case's already-`open` default.
    await handlers.update_case_status({ status: 'closed', resolution: 'solved' })
    // Verify the close actually persisted before reopening
    const closedRow = db.prepare(`SELECT status FROM cases WHERE slug='NAV-1'`).get() as {
      status: string
    }
    expect(closedRow.status).toBe('closed')
    await handlers.update_case_status({ status: 'open' })
    const row = db.prepare(`SELECT status FROM cases WHERE slug='NAV-1'`).get() as {
      status: string
    }
    expect(row.status).toBe('open')
    await expect(handlers.update_case_status({ status: 'bogus' })).rejects.toThrow(/status/i)
  })

  it('closes a case with a resolution', async () => {
    await handlers.update_case_status({ status: 'closed', resolution: 'duplicate' })
    const row = db.prepare('SELECT status, resolution FROM cases WHERE slug = ?').get('NAV-1') as {
      status: string
      resolution: string | null
    }
    expect(row.status).toBe('closed')
    expect(row.resolution).toBe('duplicate')
  })

  it('rejects closing without a resolution', async () => {
    await expect(handlers.update_case_status({ status: 'closed' })).rejects.toThrow(/resolution/i)
  })

  it('rejects an invalid resolution', async () => {
    await expect(
      handlers.update_case_status({ status: 'closed', resolution: 'bogus' })
    ).rejects.toThrow(/resolution/i)
  })

  it('read_memory returns an enabled topic body', async () => {
    await handlers.write_memory({
      topic: 'binder-crashes',
      content: 'check binder pool first',
      scope: 'correction'
    })
    const out = await handlers.read_memory({ topic: 'binder-crashes' })
    expect(out).toContain('check binder pool first')
  })

  it('read_memory refuses a disabled topic', async () => {
    await handlers.write_memory({
      topic: 'binder-crashes',
      content: 'check binder pool first',
      scope: 'correction'
    })
    const gated = argusToolHandlers({
      db,
      argusHome,
      detection,
      caseId: 1,
      caseSlug: 'NAV-1',
      sessionId: 1,
      emitFinding,
      agentAccess: () => agentAccessSchema.parse({ memory: { 'binder-crashes': false } }),
      githubWatermark: () => ({ enabled: false, text: '' })
    })
    await expect(gated.read_memory({ topic: 'binder-crashes' })).rejects.toThrow(/disabled/i)
  })

  it('write_memory refuses a disabled topic, leaving its file on disk unchanged', async () => {
    await handlers.write_memory({
      topic: 'binder-crashes',
      content: 'check binder pool first',
      scope: 'correction'
    })
    const before = fs.readFileSync(path.join(argusHome, 'memory', 'binder-crashes.md'), 'utf8')
    const gated = argusToolHandlers({
      db,
      argusHome,
      detection,
      caseId: 1,
      caseSlug: 'NAV-1',
      sessionId: 1,
      emitFinding,
      agentAccess: () => agentAccessSchema.parse({ memory: { 'binder-crashes': false } }),
      githubWatermark: () => ({ enabled: false, text: '' })
    })
    await expect(
      gated.write_memory({
        topic: 'binder-crashes',
        content: 'the agent believes this topic is new and overwrites it',
        scope: 'correction'
      })
    ).rejects.toThrow(/disabled/i)
    const after = fs.readFileSync(path.join(argusHome, 'memory', 'binder-crashes.md'), 'utf8')
    expect(after).toBe(before)
  })

  it('read_memory rejects _index and unknown topics', async () => {
    await expect(handlers.read_memory({ topic: '_index' })).rejects.toThrow(/not a topic/i)
    await expect(handlers.read_memory({ topic: 'nope' })).rejects.toThrow(/no such topic/i)
  })

  it('write_memory writes topic content, index line, and audit entry', async () => {
    const out = await handlers.write_memory({
      topic: 'binder-crashes',
      content: 'VHAL binder crashes: check the binder thread pool first.',
      scope: 'correction',
      index_entry: 'VHAL/binder crash triage order'
    })
    expect(out).toContain('binder-crashes')
    const idx = fs.readFileSync(path.join(argusHome, 'memory', '_index.md'), 'utf8')
    expect(idx).toContain('- [binder-crashes](binder-crashes.md) — VHAL/binder crash triage order')
    const topic = fs.readFileSync(path.join(argusHome, 'memory', 'binder-crashes.md'), 'utf8')
    expect(topic).toContain('binder thread pool')
  })

  it('write_memory rejects a call with no scope', async () => {
    await expect(handlers.write_memory({ topic: 'binder-crashes', content: 'x' })).rejects.toThrow(
      /scope is required/
    )
  })

  it('the write_memory spec exposes scope as an enum of the three values', () => {
    const spec = NATIVE_TOOL_SPECS.find((s) => s.name === 'write_memory')!
    expect(Object.keys(spec.schema).sort()).toEqual(['content', 'index_entry', 'scope', 'topic'])
    expect((spec.schema.scope as z.ZodEnum<never>).options).toEqual([...MEMORY_SCOPES])
  })

  it('the memory-facing descriptions state the personal-only rule and both redirects', () => {
    const wm = NATIVE_TOOL_SPECS.find((s) => s.name === 'write_memory')!.description
    expect(wm).toMatch(/preference \| environment \| correction/)
    // replace semantics: REPLACES the whole body, and read_memory first before handing it back
    expect(wm).toMatch(/REPLACES the whole topic body: call read_memory first/)
    expect(wm).toMatch(/reference-edit/)
    expect(wm).toMatch(/append_finding/)
    expect(wm).toMatch(/4096 bytes/) // byte budget

    const wp = NATIVE_TOOL_SPECS.find((s) => s.name === 'write_proposal')!.description
    // reference-edit specifically creates a reference that does not exist yet
    expect(wp).toMatch(/reference-edit CREATES the reference when the target does not exist/)
  })

  it('list_evidence shows a review session only artifacts', async () => {
    const src2 = path.join(tmp, 'ci-5.log')
    fs.writeFileSync(src2, 'log body\n')
    await ingestArtifact(
      db,
      argusHome,
      detection,
      createImmediateQueue(db, argusHome),
      'NAV-1',
      src2,
      'ci',
      {},
      'review'
    )
    const reviewSession = createSession(db, 'NAV-1', {
      driverKind: 'claude-agent-sdk',
      mode: 'review'
    })
    const reviewHandlers = argusToolHandlers({
      db,
      argusHome,
      detection,
      caseId,
      caseSlug: 'NAV-1',
      sessionId: reviewSession.id,
      emitFinding,
      githubWatermark: () => ({ enabled: false, text: '' })
    })
    const out = JSON.parse(await reviewHandlers.list_evidence({})) as Array<{ relPath: string }>
    expect(out.map((e) => e.relPath)).toEqual(['artifacts/ci-5.log'])
  })

  it('search_evidence follows the session mode in both directions', async () => {
    const src2 = path.join(tmp, 'ci-5.log')
    fs.writeFileSync(src2, 'FATAL Navigator crashed inside the review artifact\n')
    await ingestArtifact(
      db,
      argusHome,
      detection,
      createImmediateQueue(db, argusHome),
      'NAV-1',
      src2,
      'ci',
      {},
      'review'
    )

    // Both sessions are created explicitly: the beforeEach `handlers` uses a hardcoded
    // sessionId of 1 with no sessions row, and createSession would claim that id.
    const mk = (mode: 'investigation' | 'review'): ReturnType<typeof argusToolHandlers> => {
      const session = createSession(db, 'NAV-1', { driverKind: 'claude-agent-sdk', mode })
      return argusToolHandlers({
        db,
        argusHome,
        detection,
        caseId,
        caseSlug: 'NAV-1',
        sessionId: session.id,
        emitFinding,
        githubWatermark: () => ({ enabled: false, text: '' })
      })
    }

    const review = hitsOf(
      await mk('review').search_evidence({ query: 'Navigator crashed' })
    ) as Array<{ relPath: string }>
    expect(review.map((h) => h.relPath)).toEqual(['artifacts/ci-5.log'])

    const investigation = hitsOf(
      await mk('investigation').search_evidence({ query: 'Navigator crashed' })
    ) as Array<{ relPath: string }>
    expect(investigation.map((h) => h.relPath)).toEqual(['evidence/log.txt'])
  })

  it('get_artifact_meta resolves an id from either tree', async () => {
    const src2 = path.join(tmp, 'ci-5.log')
    fs.writeFileSync(src2, 'log body\n')
    // ingested into the review tree, while `handlers` runs on the default investigation session
    const rec = await ingestArtifact(
      db,
      argusHome,
      detection,
      createImmediateQueue(db, argusHome),
      'NAV-1',
      src2,
      'ci',
      {},
      'review'
    )
    const out = JSON.parse(await handlers.get_artifact_meta({ evidence_id: rec.id }))
    expect(out.relPath).toBe('artifacts/ci-5.log')
  })

  it('every native tool spec has a matching handler and vice versa', () => {
    const specNames = NATIVE_TOOL_SPECS.map((s) => s.name).sort()
    const handlerNames = Object.keys(handlers).sort()
    expect(specNames).toEqual(handlerNames)
  })
})
