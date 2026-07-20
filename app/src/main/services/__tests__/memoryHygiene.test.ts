import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import {
  isStaleCandidate,
  archiveTopic,
  restoreTopic,
  listArchivedTopics,
  type HygieneConfig
} from '../memoryHygiene'
import { applyMemoryWrite, readAudit, readIndex, readTopic } from '../memory'
import { memoryArchiveDir, memoryDir, memoryIndexPath } from '../paths'

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
    applyMemoryWrite(home, 'c', { topic: 'dup', content: 'v1', indexEntry: 'v1' })
    archiveTopic(home, 'dup')
    applyMemoryWrite(home, 'c', { topic: 'dup', content: 'v2' }) // fresh live namesake
    expect(() => restoreTopic(home, 'dup')).toThrow(/already exists/)
  })

  it('index-edit failure rolls the file move back', () => {
    applyMemoryWrite(home, 'c', { topic: 'roll', content: 'x', indexEntry: 'x' })
    // Make _index.md unwritable by replacing it with a directory of the same name.
    fs.rmSync(memoryIndexPath(home))
    fs.mkdirSync(memoryIndexPath(home))
    expect(() => archiveTopic(home, 'roll')).toThrow()
    expect(fs.existsSync(path.join(memoryDir(home), 'roll.md'))).toBe(true)
    expect(fs.existsSync(path.join(memoryArchiveDir(home), 'roll.md'))).toBe(false)
    fs.rmdirSync(memoryIndexPath(home)) // let afterEach clean up
  })
})
