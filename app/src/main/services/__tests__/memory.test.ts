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
  stripTopicEcho,
  writeTopicFile
} from '../memory'
import { memoryIndexPath } from '../paths'
import { agentAccessSchema } from '../../../shared/agentAccess'
import { MEMORY_SCOPES } from '../../../shared/memoryScope'

let tmp: string, argusHome: string

beforeEach(() => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'argus-mem-'))
  argusHome = path.join(tmp, 'home')
})

afterEach(() => {
  fs.rmSync(tmp, { recursive: true, force: true })
})

describe('stripTopicEcho', () => {
  it('drops a leading topic-name echo so the slug is not repeated a third time', () => {
    expect(stripTopicEcho('nav-fusion-drift', 'nav-fusion-drift — bearing errors follow IMU')).toBe(
      'bearing errors follow IMU'
    )
  })

  it('matches the slug space-separated and case-insensitively, and accepts : or - separators', () => {
    expect(stripTopicEcho('nav-fusion-drift', 'Nav Fusion Drift: bearing errors')).toBe(
      'bearing errors'
    )
    expect(stripTopicEcho('tile-blocks', 'TILE-BLOCKS - version rejections')).toBe(
      'version rejections'
    )
  })

  it('leaves an entry that merely starts with a similar word untouched', () => {
    expect(stripTopicEcho('nav', 'navigation drift is the usual cause')).toBe(
      'navigation drift is the usual cause'
    )
  })

  it('leaves an entry with no echo untouched', () => {
    expect(stripTopicEcho('tile-blocks', 'version rejections (BLOCKED_VERSION)')).toBe(
      'version rejections (BLOCKED_VERSION)'
    )
  })

  it('keeps a bare topic-name entry rather than emptying it', () => {
    expect(stripTopicEcho('tile-blocks', 'tile-blocks')).toBe('tile-blocks')
    expect(stripTopicEcho('tile-blocks', 'tile-blocks —   ')).toBe('tile-blocks —')
  })
})

describe('memory service', () => {
  it('index line carries the description only, not a repeated topic name', () => {
    applyMemoryWrite(argusHome, 'NAV-1', {
      topic: 'nav-fusion-drift',
      content: 'x',
      scope: 'correction',
      indexEntry: 'nav-fusion-drift — bearing errors follow an IMU warning'
    })
    expect(readIndex(argusHome)).toContain(
      '- [nav-fusion-drift](nav-fusion-drift.md) — bearing errors follow an IMU warning'
    )
  })

  it('applyMemoryWrite creates topic + index entry + audit line', () => {
    const summary = applyMemoryWrite(argusHome, 'NAV-1', {
      topic: 'tile-blocks',
      content: 'BLOCKED_VERSION means the server rejected the dataVersion.',
      scope: 'correction',
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
    applyMemoryWrite(argusHome, 'NAV-1', {
      topic: 't1',
      content: 'a',
      scope: 'correction',
      indexEntry: 'first'
    })
    applyMemoryWrite(argusHome, 'NAV-2', {
      topic: 't1',
      content: 'b',
      scope: 'correction',
      indexEntry: 'second'
    })
    const idx = readIndex(argusHome)
    expect(idx.split('\n').filter((l) => l.includes('(t1.md)'))).toHaveLength(1)
    expect(readTopic(argusHome, 't1')).toMatch(/a[\s\S]*b/)
  })

  it('rejects invalid topic names', () => {
    expect(() =>
      applyMemoryWrite(argusHome, 'NAV-1', { topic: '../evil', content: 'x', scope: 'correction' })
    ).toThrow(/topic/i)
  })

  it('rejects an indexEntry containing interior newlines', () => {
    expect(() =>
      applyMemoryWrite(argusHome, 'NAV-1', {
        topic: 't1',
        content: 'a',
        scope: 'correction',
        indexEntry: 'line one\nline two'
      })
    ).toThrow(/write_memory/)
    expect(() =>
      applyMemoryWrite(argusHome, 'NAV-1', {
        topic: 't1',
        content: 'a',
        scope: 'correction',
        indexEntry: 'line one\r\nline two'
      })
    ).toThrow(/write_memory/)
    // rejected write must not have touched the index at all
    expect(readIndex(argusHome)).toBe('')
  })

  it('rejects an indexEntry over 200 characters', () => {
    const long = 'x'.repeat(201)
    expect(() =>
      applyMemoryWrite(argusHome, 'NAV-1', {
        topic: 't1',
        content: 'a',
        scope: 'correction',
        indexEntry: long
      })
    ).toThrow(/write_memory/)
    expect(readIndex(argusHome)).toBe('')
  })

  it('accepts an indexEntry at exactly 200 characters', () => {
    const exact = 'x'.repeat(200)
    expect(() =>
      applyMemoryWrite(argusHome, 'NAV-1', {
        topic: 't1',
        content: 'a',
        scope: 'correction',
        indexEntry: exact
      })
    ).not.toThrow()
    expect(readIndex(argusHome)).toContain(exact)
  })

  it('refuses a NEW index entry at the cap with consolidation guidance', () => {
    const lines = Array.from(
      { length: MEMORY_INDEX_MAX_LINES },
      (_, i) => `- [t${i}](t${i}.md) — x`
    )
    fs.mkdirSync(path.dirname(memoryIndexPath(argusHome)), { recursive: true })
    fs.writeFileSync(memoryIndexPath(argusHome), lines.join('\n') + '\n')
    expect(() =>
      applyMemoryWrite(argusHome, 'NAV-1', {
        topic: 'new-topic',
        content: 'x',
        scope: 'correction',
        indexEntry: 'y'
      })
    ).toThrow(/consolidate/i)
  })

  it('filteredIndex drops lines for disabled topics', () => {
    applyMemoryWrite(argusHome, 'NAV-1', {
      topic: 'keep',
      content: 'k',
      scope: 'correction',
      indexEntry: 'kept'
    })
    applyMemoryWrite(argusHome, 'NAV-1', {
      topic: 'drop',
      content: 'd',
      scope: 'correction',
      indexEntry: 'dropped'
    })
    const access = agentAccessSchema.parse({ memory: { drop: false } })
    const idx = filteredIndex(argusHome, access)
    expect(idx).toContain('(keep.md)')
    expect(idx).not.toContain('(drop.md)')
  })

  it('listTopics excludes _index.md; deleteTopic removes file and index line', () => {
    applyMemoryWrite(argusHome, 'NAV-1', {
      topic: 'gone',
      content: 'g',
      scope: 'correction',
      indexEntry: 'bye'
    })
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
      applyMemoryWrite(argusHome, 'NAV-1', {
        topic: '_index',
        content: 'sneaky',
        scope: 'correction'
      })
    ).toThrow(/reserved/i)
  })

  it('deleteTopic does not remove an unrelated line whose description mentions the deleted filename', () => {
    applyMemoryWrite(argusHome, 'NAV-1', {
      topic: 'foo',
      content: 'f',
      scope: 'correction',
      indexEntry: 'foo notes'
    })
    applyMemoryWrite(argusHome, 'NAV-1', {
      topic: 'bar',
      content: 'b',
      scope: 'correction',
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
      scope: 'correction',
      indexEntry: 'see also (baz.md) for background'
    })
    applyMemoryWrite(argusHome, 'NAV-2', {
      topic: 'baz',
      content: 'b2',
      scope: 'correction',
      indexEntry: 'baz notes'
    })
    const idx = readIndex(argusHome)
    expect(idx.split('\n').filter((l) => l.includes('(baz.md)'))).toHaveLength(2)
    expect(idx).toContain('[baz](baz.md)')
  })

  it('readAudit returns entries newest-first', () => {
    applyMemoryWrite(argusHome, 'NAV-1', { topic: 't1', content: 'first', scope: 'correction' })
    applyMemoryWrite(argusHome, 'NAV-2', { topic: 't2', content: 'second', scope: 'correction' })
    applyMemoryWrite(argusHome, 'NAV-3', { topic: 't3', content: 'third', scope: 'correction' })
    const audit = readAudit(argusHome, 10)
    expect(audit.map((e) => e.caseSlug)).toEqual(['NAV-3', 'NAV-2', 'NAV-1'])
  })
})

describe('write_memory scope contract', () => {
  it('accepts each of the three scopes', () => {
    for (const scope of MEMORY_SCOPES) {
      applyMemoryWrite(argusHome, 'NAV-1', { topic: `t-${scope}`, content: 'x', scope })
      expect(readTopic(argusHome, `t-${scope}`)).toContain('x')
    }
  })

  it('rejects a missing scope and names both alternative destinations', () => {
    expect(() =>
      applyMemoryWrite(argusHome, 'NAV-1', { topic: 'nope', content: 'x', scope: '' })
    ).toThrow(/scope is required/)
    expect(() =>
      applyMemoryWrite(argusHome, 'NAV-1', { topic: 'nope', content: 'x', scope: '' })
    ).toThrow(/reference-edit/)
    expect(fs.existsSync(path.join(argusHome, 'memory', 'nope.md'))).toBe(false)
  })

  it('rejects a fourth scope value, echoing what was passed', () => {
    expect(() =>
      applyMemoryWrite(argusHome, 'NAV-1', { topic: 'nope', content: 'x', scope: 'workflow' })
    ).toThrow(/"workflow" is not a valid scope/)
    expect(fs.existsSync(path.join(argusHome, 'memory', 'nope.md'))).toBe(false)
  })

  it('records the scope in the audit entry', () => {
    applyMemoryWrite(argusHome, 'NAV-1', {
      topic: 'dlt',
      content: 'x',
      scope: 'environment',
      indexEntry: 'entry'
    })
    expect(readAudit(argusHome, 10)[0]).toMatchObject({ topic: 'dlt', scope: 'environment' })
  })

  it('still parses a pre-feature audit line that has no scope', () => {
    fs.mkdirSync(path.join(argusHome, 'memory'), { recursive: true })
    fs.appendFileSync(
      path.join(argusHome, 'memory', '.audit.jsonl'),
      JSON.stringify({
        ts: '2026-07-01T00:00:00.000Z',
        caseSlug: 'OLD-1',
        topic: 'legacy',
        indexEntry: null,
        bytes: 12
      }) + '\n'
    )
    const entries = readAudit(argusHome, 10)
    expect(entries[0].topic).toBe('legacy')
    expect(entries[0].scope).toBeUndefined()
  })
})
