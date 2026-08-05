import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import {
  isStaleCandidate,
  archiveTopic,
  restoreTopic,
  listArchivedTopics,
  type HygieneConfig
} from '../memoryHygiene'
import { applyMemoryWrite, readAudit, readIndex, readTopic } from '../memory'
import { memoryArchiveDir, memoryBackupDir, memoryDir } from '../paths'

let home: string
beforeEach(() => {
  home = fs.mkdtempSync(path.join(os.tmpdir(), 'argus-hygiene-'))
})
afterEach(() => fs.rmSync(home, { recursive: true, force: true }))

const cfg: HygieneConfig = {
  staleDays: 45,
  minRecalls: 3,
  trackingStartedAt: '2026-01-01T00:00:00.000Z'
}
const NOW = new Date('2026-07-20T00:00:00.000Z') // 200 days after epoch

describe('isStaleCandidate', () => {
  const old = '2026-01-02T00:00:00.000Z' // ~199 days before NOW
  const fresh = '2026-07-10T00:00:00.000Z' // 10 days before NOW
  it('stale: old lastUsed + few recalls + grace elapsed', () => {
    expect(
      isStaleCandidate({ lastRecalledAt: old, lastWrittenAt: old, recallCount: 1 }, cfg, NOW)
    ).toBe(true)
  })
  it('never-used topic (no recall, no write timestamp) is stale', () => {
    expect(
      isStaleCandidate({ lastRecalledAt: null, lastWrittenAt: null, recallCount: 0 }, cfg, NOW)
    ).toBe(true)
  })
  it('recent recall OR recent write rescues it', () => {
    expect(
      isStaleCandidate({ lastRecalledAt: fresh, lastWrittenAt: old, recallCount: 0 }, cfg, NOW)
    ).toBe(false)
    expect(
      isStaleCandidate({ lastRecalledAt: null, lastWrittenAt: fresh, recallCount: 0 }, cfg, NOW)
    ).toBe(false)
  })
  it('enough recalls rescue it even when idle', () => {
    expect(
      isStaleCandidate({ lastRecalledAt: old, lastWrittenAt: old, recallCount: 3 }, cfg, NOW)
    ).toBe(false)
  })
  it('grace period: nothing is stale until trackingStartedAt + staleDays', () => {
    const early = new Date('2026-02-01T00:00:00.000Z') // 31 days after epoch < 45
    expect(
      isStaleCandidate({ lastRecalledAt: null, lastWrittenAt: null, recallCount: 0 }, cfg, early)
    ).toBe(false)
    expect(
      isStaleCandidate(
        { lastRecalledAt: null, lastWrittenAt: null, recallCount: 0 },
        { ...cfg, trackingStartedAt: '' },
        NOW
      )
    ).toBe(false)
  })
})

describe('archive / restore round-trip', () => {
  it('archive moves the file, drops the index line, audits with the saved line; restore reverses all', () => {
    applyMemoryWrite(home, 'case-1', {
      topic: 'nav-drift',
      content: 'bearing errors follow an IMU warning',
      scope: 'preference',
      indexEntry: 'bearing errors follow an IMU warning'
    })
    const lineBefore = readIndex(home)
    expect(lineBefore).toContain('nav-drift')

    archiveTopic(home, 'nav-drift')
    expect(fs.existsSync(path.join(memoryDir(home), 'nav-drift.md'))).toBe(false)
    expect(fs.existsSync(path.join(memoryArchiveDir(home), 'nav-drift.md'))).toBe(true)
    expect(readIndex(home)).not.toContain('nav-drift')
    const audit = readAudit(home, 10)
    expect(audit[0]).toMatchObject({ topic: 'nav-drift', action: 'archive' })
    expect(audit[0].indexEntry).toContain('nav-drift.md')
    expect(listArchivedTopics(home).map((a) => a.topic)).toEqual(['nav-drift'])

    restoreTopic(home, 'nav-drift')
    expect(readTopic(home, 'nav-drift')).toContain('bearing errors')
    expect(readIndex(home)).toContain('nav-drift')
    expect(listArchivedTopics(home)).toEqual([])
    expect(readAudit(home, 10)[0]).toMatchObject({ topic: 'nav-drift', action: 'restore' })
  })

  it('archive of a missing topic / restore onto a live namesake are rejected', () => {
    expect(() => archiveTopic(home, 'nope')).toThrow(/No such topic/)
    applyMemoryWrite(home, 'c', {
      topic: 'dup',
      content: 'v1',
      scope: 'preference',
      indexEntry: 'v1'
    })
    archiveTopic(home, 'dup')
    applyMemoryWrite(home, 'c', { topic: 'dup', content: 'v2', scope: 'preference' }) // fresh live namesake
    expect(() => restoreTopic(home, 'dup')).toThrow(/already exists/)
  })

  it('index-edit failure rolls the file move back', () => {
    applyMemoryWrite(home, 'c', {
      topic: 'roll',
      content: 'x',
      scope: 'preference',
      indexEntry: 'x'
    })
    // readIndex must still succeed (archiveTopic calls it BEFORE the rename) — only the index
    // *write* fails, so the rename actually happens and the rollback branch runs. Replacing
    // _index.md with a directory fails readIndex's existsSync/readFileSync first and never
    // reaches the rename at all, which would make this pass vacuously.
    const spy = vi.spyOn(fs, 'writeFileSync').mockImplementationOnce(() => {
      throw new Error('boom')
    })
    try {
      expect(() => archiveTopic(home, 'roll')).toThrow()
    } finally {
      spy.mockRestore()
    }
    expect(fs.existsSync(path.join(memoryDir(home), 'roll.md'))).toBe(true)
    expect(fs.existsSync(path.join(memoryArchiveDir(home), 'roll.md'))).toBe(false)
  })

  // Same reasoning as deleteTopic: an archived topic's leftover backup is invisible and, if the
  // name is later reused, would hand the new topic a stranger's recoverable body.
  it('archiveTopic removes the backup along with the live file', () => {
    applyMemoryWrite(home, 'c', { topic: 'nav-drift', content: 'v1', scope: 'preference' })
    applyMemoryWrite(home, 'c', { topic: 'nav-drift', content: 'v2', scope: 'preference' })
    const bak = path.join(memoryBackupDir(home), 'nav-drift.md')
    expect(fs.existsSync(bak)).toBe(true)
    archiveTopic(home, 'nav-drift')
    expect(fs.existsSync(bak)).toBe(false)
  })

  it('archiveTopic on a topic with no backup does not throw', () => {
    applyMemoryWrite(home, 'c', { topic: 'nav-drift', content: 'v1', scope: 'preference' })
    expect(fs.existsSync(path.join(memoryBackupDir(home), 'nav-drift.md'))).toBe(false)
    expect(() => archiveTopic(home, 'nav-drift')).not.toThrow()
  })

  it('a rolled-back archive (index-edit failure) leaves the backup untouched', () => {
    applyMemoryWrite(home, 'c', { topic: 'roll', content: 'v1', scope: 'preference', indexEntry: 'x' })
    applyMemoryWrite(home, 'c', { topic: 'roll', content: 'v2', scope: 'preference' })
    const bak = path.join(memoryBackupDir(home), 'roll.md')
    expect(fs.existsSync(bak)).toBe(true)
    const live = path.join(memoryDir(home), 'roll.md')
    const dest = path.join(memoryArchiveDir(home), 'roll.md')
    // Fail the index *write*, not readIndex — this must actually rename the file and enter the
    // rollback branch, or the backup-survives assertion below holds vacuously (see the sibling
    // "index-edit failure rolls the file move back" test for why a directory-shadowed
    // _index.md doesn't exercise the rollback at all).
    const spy = vi.spyOn(fs, 'writeFileSync').mockImplementationOnce(() => {
      throw new Error('boom')
    })
    try {
      expect(() => archiveTopic(home, 'roll')).toThrow()
    } finally {
      spy.mockRestore()
    }
    // rollback actually ran: the live file is back, the archive destination is empty
    expect(fs.existsSync(live)).toBe(true)
    expect(fs.existsSync(dest)).toBe(false)
    // the archive never completed, so its one recoverable level must survive the rollback
    expect(fs.existsSync(bak)).toBe(true)
  })
})
