import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { SettingsService } from '../../settings'
import { ensureTrackingStarted, usageStats } from '../usage'
import { openDb } from '../../db'
import { applyMemoryWrite } from '../../memory'
import { archiveTopic } from '../../memoryHygiene'
import { defaultAgentAccess } from '../../../../shared/agentAccess'

let tmp: string
beforeEach(() => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'argus-usage-'))
})
afterEach(() => fs.rmSync(tmp, { recursive: true, force: true }))

describe('ensureTrackingStarted', () => {
  it('stamps once and never re-stamps', () => {
    const svc = new SettingsService(tmp)
    const t0 = new Date('2026-07-20T00:00:00.000Z')
    const first = ensureTrackingStarted(svc, () => t0)
    expect(first).toBe('2026-07-20T00:00:00.000Z')
    const second = ensureTrackingStarted(svc, () => new Date('2027-01-01T00:00:00.000Z'))
    expect(second).toBe('2026-07-20T00:00:00.000Z')
    expect(svc.get().memoryHygiene.trackingStartedAt).toBe('2026-07-20T00:00:00.000Z')
    svc.close()
  })
})

function seedCase(db: ReturnType<typeof openDb>): void {
  db.prepare(
    `INSERT INTO cases (slug, title, created_at, updated_at) VALUES ('c','t','x','x')`
  ).run()
}
function logCall(
  db: ReturnType<typeof openDb>,
  tool: string,
  detail: string | null,
  createdAt: string,
  decision = 'auto'
): void {
  db.prepare(
    `INSERT INTO tool_calls (case_id, session_id, tool, args_hash, detail, risk, decision, created_at)
     VALUES (1, 1, ?, 'h', ?, 'LOW', ?, ?)`
  ).run(tool, detail, decision, createdAt)
}
const HYG = { staleDays: 45, minRecalls: 3, trackingStartedAt: '2026-01-01T00:00:00.000Z' }
const NOW = (): Date => new Date('2026-07-20T00:00:00.000Z')

function seedDistillJob(
  db: ReturnType<typeof openDb>,
  caseSlug: string,
  over: {
    kind?: string
    state?: string
    costUsd?: number | null
    turnCount?: number | null
    toolCallCount?: number | null
    promptChars?: number | null
    dryRun?: boolean
    finishedAt?: string
  } = {}
): void {
  db.prepare(
    `INSERT INTO distill_jobs
       (case_slug, state, input_snapshot, kind, cost_usd, turn_count, tool_call_count,
        prompt_chars, created_at, dry_run, finished_at)
     VALUES (?, ?, '{}', ?, ?, ?, ?, ?, ?, ?, ?)`
  ).run(
    caseSlug,
    over.state ?? 'done',
    over.kind ?? 'case',
    over.costUsd ?? null,
    over.turnCount ?? null,
    over.toolCallCount ?? null,
    over.promptChars ?? null,
    '2026-07-01T00:00:00.000Z',
    over.dryRun ? 1 : 0,
    over.finishedAt ?? null
  )
}

describe('usageStats', () => {
  it('aggregates skills by name with zero-count rows for never-activated resolved skills', () => {
    const db = openDb(':memory:')
    seedCase(db)
    // one resolved skill on disk, tier bundled
    fs.mkdirSync(path.join(tmp, 'skills', 'verify'), { recursive: true })
    fs.writeFileSync(path.join(tmp, 'skills', 'verify', 'SKILL.md'), '---\ndescription: v\n---\n')
    fs.mkdirSync(path.join(tmp, 'skills', 'never-used'), { recursive: true })
    fs.writeFileSync(
      path.join(tmp, 'skills', 'never-used', 'SKILL.md'),
      '---\ndescription: n\n---\n'
    )
    logCall(db, 'Skill', 'verify', '2026-07-01T00:00:00.000Z')
    logCall(db, 'Skill', 'verify', '2026-07-02T00:00:00.000Z')
    logCall(db, 'Skill', 'ghost', '2026-07-03T00:00:00.000Z') // no longer on disk
    logCall(db, 'Skill', 'verify', '2026-07-04T00:00:00.000Z', 'denied') // excluded
    const s = usageStats({
      db,
      argusHome: tmp,
      access: defaultAgentAccess(),
      hygiene: HYG,
      now: NOW
    })
    expect(s.skills).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          name: 'verify',
          tier: 'bundled',
          activationCount: 2,
          lastActivatedAt: '2026-07-02T00:00:00.000Z'
        }),
        expect.objectContaining({
          name: 'never-used',
          tier: 'bundled',
          activationCount: 0,
          lastActivatedAt: null
        }),
        expect.objectContaining({ name: 'ghost', tier: null, activationCount: 1 })
      ])
    )
  })

  it('memory rows: recalls from tool_calls, lastWritten from the topic file, stale flag applied', () => {
    const db = openDb(':memory:')
    seedCase(db)
    applyMemoryWrite(tmp, 'c', { topic: 'hot', content: 'x', scope: 'preference' })
    applyMemoryWrite(tmp, 'c', { topic: 'cold', content: 'y', scope: 'preference' })
    logCall(db, 'mcp__argus__read_memory', 'hot', '2026-07-19T00:00:00.000Z')
    const s = usageStats({
      db,
      argusHome: tmp,
      access: defaultAgentAccess(),
      hygiene: HYG,
      now: NOW
    })
    const hot = s.memory.find((m) => m.topic === 'hot')!
    const cold = s.memory.find((m) => m.topic === 'cold')!
    expect(hot).toMatchObject({
      recallCount: 1,
      lastRecalledAt: '2026-07-19T00:00:00.000Z',
      staleCandidate: false
    })
    // cold was just written (file mtime = now-ish) → NOT stale despite zero recalls
    expect(cold).toMatchObject({ recallCount: 0, lastRecalledAt: null, staleCandidate: false })
    expect(cold.lastWrittenAt).not.toBeNull()
  })

  it('reference rows: read counts by relPath plus zero-count rows for unread files', () => {
    const db = openDb(':memory:')
    seedCase(db)
    const refs = path.join(tmp, 'references')
    fs.mkdirSync(path.join(refs, 'playbooks'), { recursive: true })
    fs.writeFileSync(path.join(refs, 'playbooks', 'triage.md'), 'x')
    fs.writeFileSync(path.join(refs, 'unread.md'), 'y')
    fs.writeFileSync(path.join(refs, 'INDEX.md'), 'router') // generated router — excluded
    logCall(db, 'Read', 'ref:playbooks/triage.md', '2026-07-10T00:00:00.000Z')
    const s = usageStats({
      db,
      argusHome: tmp,
      access: defaultAgentAccess(),
      hygiene: HYG,
      now: NOW
    })
    expect(s.references).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          relPath: 'playbooks/triage.md',
          readCount: 1,
          lastReadAt: '2026-07-10T00:00:00.000Z'
        }),
        expect.objectContaining({ relPath: 'unread.md', readCount: 0, lastReadAt: null })
      ])
    )
    expect(s.references.some((r) => r.relPath === 'INDEX.md')).toBe(false)
  })

  it('includes archived topics and the hygiene config', () => {
    const db = openDb(':memory:')
    seedCase(db)
    applyMemoryWrite(tmp, 'c', { topic: 'bye', content: 'z', scope: 'preference' })
    archiveTopic(tmp, 'bye')
    const s = usageStats({
      db,
      argusHome: tmp,
      access: defaultAgentAccess(),
      hygiene: HYG,
      now: NOW
    })
    expect(s.archived.map((a) => a.topic)).toEqual(['bye'])
    expect(s.memory.some((m) => m.topic === 'bye')).toBe(false)
    expect(s.hygiene).toEqual(HYG)
  })

  describe('distillation', () => {
    it('averages usage columns over done case jobs, ignoring NULL fields rather than coercing to 0', () => {
      const db = openDb(':memory:')
      seedCase(db)
      seedDistillJob(db, 'c', {
        costUsd: 0.5,
        turnCount: 10,
        toolCallCount: 4,
        promptChars: 2000
      })
      seedDistillJob(db, 'c', {
        costUsd: 1.5,
        turnCount: 20,
        toolCallCount: 8,
        promptChars: 4000
      })
      // pre-v2 done row: every usage column NULL — must not be coerced into a $0.00/0-turn entry
      seedDistillJob(db, 'c')
      const s = usageStats({
        db,
        argusHome: tmp,
        access: defaultAgentAccess(),
        hygiene: HYG,
        now: NOW
      })
      expect(s.distillation).toEqual({
        jobCount: 3,
        totalCostUsd: 2,
        avgCostUsd: 1,
        avgPromptChars: 3000,
        avgTurnCount: 15,
        failedCostUsd: null,
        failedCount: 0,
        dryRunCount: 0,
        dryRunCostUsd: null
      })
    })

    it('jobCount/averages exclude queued/running/failed/cancelled rows and non-case kinds, but failedCostUsd counts failed spend', () => {
      const db = openDb(':memory:')
      seedCase(db)
      seedDistillJob(db, 'c', { costUsd: 1, turnCount: 5, toolCallCount: 2, promptChars: 100 })
      seedDistillJob(db, 'c', { state: 'queued', costUsd: null })
      // Failed capHit runs are the expensive ones (they ran the whole agent loop and still
      // refused to parse) — their spend must not vanish from the rollup even though they never
      // become a `done` job. jobCount/averages stay done-only; only failedCostUsd sees this row.
      seedDistillJob(db, 'c', { state: 'failed', costUsd: 9, turnCount: 99, toolCallCount: 99 })
      seedDistillJob(db, 'c', { kind: 'reject-digest', state: 'done', costUsd: 9 })
      const s = usageStats({
        db,
        argusHome: tmp,
        access: defaultAgentAccess(),
        hygiene: HYG,
        now: NOW
      })
      expect(s.distillation).toEqual({
        jobCount: 1,
        totalCostUsd: 1,
        avgCostUsd: 1,
        avgPromptChars: 100,
        avgTurnCount: 5,
        failedCostUsd: 9,
        failedCount: 1,
        dryRunCount: 0,
        dryRunCostUsd: null
      })
    })

    it('reports jobCount with every average null when no done case job has ever recorded usage', () => {
      const db = openDb(':memory:')
      seedCase(db)
      seedDistillJob(db, 'c') // done, but every usage column NULL (pre-v2 row)
      const s = usageStats({
        db,
        argusHome: tmp,
        access: defaultAgentAccess(),
        hygiene: HYG,
        now: NOW
      })
      expect(s.distillation).toEqual({
        jobCount: 1,
        totalCostUsd: null,
        avgCostUsd: null,
        avgPromptChars: null,
        avgTurnCount: null,
        failedCostUsd: null,
        failedCount: 0,
        dryRunCount: 0,
        dryRunCostUsd: null
      })
    })

    it('reports an all-null, zero-count row when no done case job exists at all', () => {
      const db = openDb(':memory:')
      seedCase(db)
      const s = usageStats({
        db,
        argusHome: tmp,
        access: defaultAgentAccess(),
        hygiene: HYG,
        now: NOW
      })
      expect(s.distillation).toEqual({
        jobCount: 0,
        totalCostUsd: null,
        avgCostUsd: null,
        avgPromptChars: null,
        avgTurnCount: null,
        failedCostUsd: null,
        failedCount: 0,
        dryRunCount: 0,
        dryRunCostUsd: null
      })
    })

    it('excludes done dry runs from jobCount and totalCostUsd, counting only the real job', () => {
      const db = openDb(':memory:')
      seedCase(db)
      seedDistillJob(db, 'c', { costUsd: 1, turnCount: 5, toolCallCount: 2, promptChars: 100 })
      // A done dry run (comparison run) with a distinguishable cost — if the dry_run filter
      // were ever dropped, this cost would silently inflate totalCostUsd/avgCostUsd too, not
      // just jobCount, so both must be asserted.
      seedDistillJob(db, 'c', {
        costUsd: 1000,
        turnCount: 999,
        toolCallCount: 999,
        promptChars: 99999,
        dryRun: true
      })
      const s = usageStats({
        db,
        argusHome: tmp,
        access: defaultAgentAccess(),
        hygiene: HYG,
        now: NOW
      })
      expect(s.distillation.jobCount).toBe(1)
      expect(s.distillation.totalCostUsd).toBe(1)
      expect(s.distillation).toEqual({
        jobCount: 1,
        totalCostUsd: 1,
        avgCostUsd: 1,
        avgPromptChars: 100,
        avgTurnCount: 5,
        failedCostUsd: null,
        failedCount: 0,
        dryRunCount: 1,
        dryRunCostUsd: 1000
      })
    })

    it('sums cost across multiple failed runs, independent of the done-only jobCount', () => {
      const db = openDb(':memory:')
      seedCase(db)
      seedDistillJob(db, 'c', { state: 'failed', costUsd: 2 })
      seedDistillJob(db, 'c', { state: 'failed', costUsd: 3 })
      const s = usageStats({
        db,
        argusHome: tmp,
        access: defaultAgentAccess(),
        hygiene: HYG,
        now: NOW
      })
      expect(s.distillation.jobCount).toBe(0)
      expect(s.distillation.failedCostUsd).toBe(5)
      expect(s.distillation.failedCount).toBe(2)
    })
  })

  describe('distillationStats — range and dry runs', () => {
    it('counts only rows finished at/after since, and reports dry-run spend separately', () => {
      const db = openDb(path.join(tmp, 'a.db'))
      seedCase(db)
      seedDistillJob(db, 'c', { state: 'done', costUsd: 1, finishedAt: '2026-07-01T00:00:00.000Z' })
      seedDistillJob(db, 'c', { state: 'done', costUsd: 2, finishedAt: '2026-07-15T00:00:00.000Z' })
      seedDistillJob(db, 'c', {
        state: 'done',
        costUsd: 4,
        dryRun: true,
        finishedAt: '2026-07-15T00:00:00.000Z'
      })
      seedDistillJob(db, 'c', {
        state: 'failed',
        costUsd: 8,
        dryRun: true,
        finishedAt: '2026-07-16T00:00:00.000Z'
      })
      // real (non-dry) failed run — its spend must land in failedCostUsd/failedCount but not
      // in totalCostUsd (which stays scoped to `done` rows).
      seedDistillJob(db, 'c', {
        state: 'failed',
        costUsd: 0.5,
        finishedAt: '2026-07-15T00:00:00.000Z'
      })
      const all = usageStats({
        db,
        argusHome: tmp,
        access: defaultAgentAccess(),
        hygiene: HYG,
        now: NOW
      }).distillation
      expect(all.jobCount).toBe(2)
      expect(all.totalCostUsd).toBe(3)
      expect(all.dryRunCount).toBe(2)
      expect(all.dryRunCostUsd).toBe(12)
      expect(all.failedCount).toBe(1)
      expect(all.failedCostUsd).toBe(0.5)
      const recent = usageStats({
        db,
        argusHome: tmp,
        access: defaultAgentAccess(),
        hygiene: HYG,
        now: NOW,
        since: '2026-07-10T00:00:00.000Z'
      }).distillation
      expect(recent.jobCount).toBe(1)
      expect(recent.totalCostUsd).toBe(2)
      expect(recent.dryRunCostUsd).toBe(12)
      expect(recent.failedCount).toBe(1)
      expect(recent.failedCostUsd).toBe(0.5)
      db.close()
    })
  })
})
