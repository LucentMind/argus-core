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
    applyMemoryWrite(tmp, 'c', { topic: 'hot', content: 'x' })
    applyMemoryWrite(tmp, 'c', { topic: 'cold', content: 'y' })
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
    applyMemoryWrite(tmp, 'c', { topic: 'bye', content: 'z' })
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
})
