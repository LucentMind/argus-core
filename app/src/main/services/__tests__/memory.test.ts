import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import {
  MEMORY_INDEX_MAX_LINES,
  applyMemoryWrite,
  deleteTopic,
  filteredIndex,
  listTopics,
  readAudit,
  readIndex,
  readTopic,
  writeTopicFile
} from '../memory'
import { memoryIndexPath } from '../paths'
import { agentAccessSchema } from '../../../shared/agentAccess'

let tmp: string, argusHome: string

beforeEach(() => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'argus-mem-'))
  argusHome = path.join(tmp, 'home')
})

afterEach(() => {
  fs.rmSync(tmp, { recursive: true, force: true })
})

describe('memory service', () => {
  it('applyMemoryWrite creates topic + index entry + audit line', () => {
    const summary = applyMemoryWrite(argusHome, 'NAV-1', {
      topic: 'tile-blocks',
      content: 'BLOCKED_VERSION means the server rejected the dataVersion.',
      indexEntry: 'tile version rejections (BLOCKED_VERSION)'
    })
    expect(summary).toContain('tile-blocks')
    expect(readTopic(argusHome, 'tile-blocks')).toContain('BLOCKED_VERSION')
    expect(readIndex(argusHome)).toContain(
      '- [tile-blocks](tile-blocks.md) — tile version rejections'
    )
    const audit = readAudit(argusHome, 10)
    expect(audit).toHaveLength(1)
    expect(audit[0].caseSlug).toBe('NAV-1')
    expect(audit[0].topic).toBe('tile-blocks')
  })

  it('append to an existing topic does not duplicate the index line', () => {
    applyMemoryWrite(argusHome, 'NAV-1', { topic: 't1', content: 'a', indexEntry: 'first' })
    applyMemoryWrite(argusHome, 'NAV-2', { topic: 't1', content: 'b', indexEntry: 'second' })
    const idx = readIndex(argusHome)
    expect(idx.split('\n').filter((l) => l.includes('(t1.md)'))).toHaveLength(1)
    expect(readTopic(argusHome, 't1')).toMatch(/a[\s\S]*b/)
  })

  it('rejects invalid topic names', () => {
    expect(() => applyMemoryWrite(argusHome, 'NAV-1', { topic: '../evil', content: 'x' })).toThrow(
      /topic/i
    )
  })

  it('refuses a NEW index entry at the cap with consolidation guidance', () => {
    const lines = Array.from(
      { length: MEMORY_INDEX_MAX_LINES },
      (_, i) => `- [t${i}](t${i}.md) — x`
    )
    fs.mkdirSync(path.dirname(memoryIndexPath(argusHome)), { recursive: true })
    fs.writeFileSync(memoryIndexPath(argusHome), lines.join('\n') + '\n')
    expect(() =>
      applyMemoryWrite(argusHome, 'NAV-1', { topic: 'new-topic', content: 'x', indexEntry: 'y' })
    ).toThrow(/consolidate/i)
  })

  it('filteredIndex drops lines for disabled topics', () => {
    applyMemoryWrite(argusHome, 'NAV-1', { topic: 'keep', content: 'k', indexEntry: 'kept' })
    applyMemoryWrite(argusHome, 'NAV-1', { topic: 'drop', content: 'd', indexEntry: 'dropped' })
    const access = agentAccessSchema.parse({ memory: { drop: false } })
    const idx = filteredIndex(argusHome, access)
    expect(idx).toContain('(keep.md)')
    expect(idx).not.toContain('(drop.md)')
  })

  it('listTopics excludes _index.md; deleteTopic removes file and index line', () => {
    applyMemoryWrite(argusHome, 'NAV-1', { topic: 'gone', content: 'g', indexEntry: 'bye' })
    expect(listTopics(argusHome).map((t) => t.name)).toEqual(['gone'])
    deleteTopic(argusHome, 'gone')
    expect(listTopics(argusHome)).toEqual([])
    expect(readIndex(argusHome)).not.toContain('(gone.md)')
  })

  it('writeTopicFile overwrites; _index is addressable', () => {
    writeTopicFile(argusHome, '_index', '- [x](x.md) — hand edit\n')
    expect(readTopic(argusHome, '_index')).toContain('hand edit')
  })

  it('applyMemoryWrite rejects the reserved _index topic', () => {
    expect(() =>
      applyMemoryWrite(argusHome, 'NAV-1', { topic: '_index', content: 'sneaky' })
    ).toThrow(/reserved/i)
  })

  it('deleteTopic does not remove an unrelated line whose description mentions the deleted filename', () => {
    applyMemoryWrite(argusHome, 'NAV-1', { topic: 'foo', content: 'f', indexEntry: 'foo notes' })
    applyMemoryWrite(argusHome, 'NAV-1', {
      topic: 'bar',
      content: 'b',
      indexEntry: 'see also (foo.md) for background'
    })
    deleteTopic(argusHome, 'foo')
    const idx = readIndex(argusHome)
    expect(idx).not.toContain('[foo](foo.md)')
    expect(idx).toContain('(bar.md)')
    expect(idx).toContain('see also (foo.md) for background')
  })

  it('applyMemoryWrite duplicate-index detection is not fooled by description text referencing another topic filename', () => {
    applyMemoryWrite(argusHome, 'NAV-1', {
      topic: 'bar',
      content: 'b1',
      indexEntry: 'see also (baz.md) for background'
    })
    applyMemoryWrite(argusHome, 'NAV-2', { topic: 'baz', content: 'b2', indexEntry: 'baz notes' })
    const idx = readIndex(argusHome)
    expect(idx.split('\n').filter((l) => l.includes('(baz.md)'))).toHaveLength(2)
    expect(idx).toContain('[baz](baz.md)')
  })

  it('readAudit returns entries newest-first', () => {
    applyMemoryWrite(argusHome, 'NAV-1', { topic: 't1', content: 'first' })
    applyMemoryWrite(argusHome, 'NAV-2', { topic: 't2', content: 'second' })
    applyMemoryWrite(argusHome, 'NAV-3', { topic: 't3', content: 'third' })
    const audit = readAudit(argusHome, 10)
    expect(audit.map((e) => e.caseSlug)).toEqual(['NAV-3', 'NAV-2', 'NAV-1'])
  })
})
