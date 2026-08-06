import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import {
  MEMORY_INDEX_MAX_LINES,
  MEMORY_TOPIC_MAX_BYTES,
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
import { memoryDir, memoryIndexPath } from '../paths'
import { agentAccessSchema } from '../../../shared/agentAccess'
import { MEMORY_SCOPES } from '../../../shared/memoryScope'
import { fmBlock, fmField, withFrontmatter } from '../../../shared/frontmatter'

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

  it('writing again to an existing topic does not duplicate the index line', () => {
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
    // the second write REPLACES the topic body — see "replace semantics" below. Assert against
    // the parsed body, not the raw file: raw now carries frontmatter (`scope: correction`), and
    // a bare `.not.toContain('a')` against raw only survives because no stamped key today
    // happens to contain the letter 'a' — a future key like `updated_at:` would break it.
    const raw = readTopic(argusHome, 't1')
    expect(fmBlock(raw)!.body).toContain('b')
    expect(fmBlock(raw)!.body).not.toContain('a')
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

describe('write_memory is gated on topicEnabled, symmetric with read_memory', () => {
  it('rejects a write to a topic disabled by agent access, leaving the file on disk unchanged', () => {
    applyMemoryWrite(argusHome, 'NAV-1', {
      topic: 'binder',
      content: 'original content the user hid this topic to protect',
      scope: 'correction'
    })
    const access = agentAccessSchema.parse({ memory: { binder: false } })
    expect(() =>
      applyMemoryWrite(
        argusHome,
        'NAV-1',
        { topic: 'binder', content: 'overwritten by the agent', scope: 'correction' },
        undefined,
        access
      )
    ).toThrow(/disabled/i)
    const body = readTopic(argusHome, 'binder')
    expect(body).toContain('original content')
    expect(body).not.toContain('overwritten')
    // a rejected write must not even leave a .bak — nothing touched disk
    expect(fs.existsSync(path.join(argusHome, 'memory', '.bak', 'binder.md'))).toBe(false)
  })

  it('a disabled topic that does not exist yet still cannot be created', () => {
    const access = agentAccessSchema.parse({ memory: { 'new-topic': false } })
    expect(() =>
      applyMemoryWrite(
        argusHome,
        'NAV-1',
        { topic: 'new-topic', content: 'x', scope: 'preference' },
        undefined,
        access
      )
    ).toThrow(/disabled/i)
    expect(fs.existsSync(path.join(argusHome, 'memory', 'new-topic.md'))).toBe(false)
  })

  it('does not gate when no access is supplied — default is everything enabled', () => {
    expect(() =>
      applyMemoryWrite(argusHome, 'NAV-1', { topic: 'binder', content: 'x', scope: 'correction' })
    ).not.toThrow()
  })
})

describe('applyMemoryWrite coerces scope before validating it', () => {
  it('a non-string scope (e.g. undefined) hits the missing-scope feedback, not a bare TypeError', () => {
    expect(() =>
      applyMemoryWrite(argusHome, 'NAV-1', {
        topic: 'nope',
        content: 'x',
        scope: undefined as unknown as string
      })
    ).toThrow(/scope is required/)
  })
})

describe('write order matches the documented data flow: backup+body land before the index line', () => {
  it('a failure taking the .bak backup leaves the index without the new line', () => {
    applyMemoryWrite(argusHome, 'NAV-1', { topic: 'dlt', content: 'first', scope: 'preference' })
    const spy = vi.spyOn(fs, 'copyFileSync').mockImplementation(() => {
      throw new Error('EPERM: simulated backup failure')
    })
    try {
      expect(() =>
        applyMemoryWrite(argusHome, 'NAV-1', {
          topic: 'dlt',
          content: 'second',
          scope: 'preference',
          indexEntry: 'a brand new index line'
        })
      ).toThrow(/EPERM/)
      // Old order wrote the index line first; under the fixed order this write never reached
      // the index step, so the line must be absent.
      expect(readIndex(argusHome)).not.toContain('a brand new index line')
    } finally {
      spy.mockRestore()
    }
  })
})

describe('replace semantics and the single-level backup', () => {
  const bak = (topic: string): string => path.join(argusHome, 'memory', '.bak', `${topic}.md`)

  it('replaces the topic body rather than appending to it', () => {
    applyMemoryWrite(argusHome, 'NAV-1', {
      topic: 'dlt',
      content: 'first fact',
      scope: 'environment'
    })
    applyMemoryWrite(argusHome, 'NAV-1', {
      topic: 'dlt',
      content: 'second fact',
      scope: 'environment'
    })
    const body = readTopic(argusHome, 'dlt')
    expect(body).toContain('second fact')
    expect(body).not.toContain('first fact')
  })

  it('takes no backup on a first write and keeps the previous body on a replace', () => {
    applyMemoryWrite(argusHome, 'NAV-1', {
      topic: 'dlt',
      content: 'first fact',
      scope: 'preference'
    })
    expect(fs.existsSync(bak('dlt'))).toBe(false)
    applyMemoryWrite(argusHome, 'NAV-1', {
      topic: 'dlt',
      content: 'second fact',
      scope: 'preference'
    })
    expect(fs.readFileSync(bak('dlt'), 'utf8')).toContain('first fact')
  })

  it('overwrites the backup each time — one level, no rotation', () => {
    for (const c of ['one', 'two', 'three']) {
      applyMemoryWrite(argusHome, 'NAV-1', { topic: 'dlt', content: c, scope: 'preference' })
    }
    const saved = fs.readFileSync(bak('dlt'), 'utf8')
    expect(saved).toContain('two')
    expect(saved).not.toContain('one')
    expect(fs.readdirSync(path.join(argusHome, 'memory', '.bak'))).toEqual(['dlt.md'])
  })

  it('never lists .bak as a topic', () => {
    applyMemoryWrite(argusHome, 'NAV-1', { topic: 'dlt', content: 'a', scope: 'preference' })
    applyMemoryWrite(argusHome, 'NAV-1', { topic: 'dlt', content: 'b', scope: 'preference' })
    expect(listTopics(argusHome).map((t) => t.name)).toEqual(['dlt'])
  })

  // Without this, the backup outlives the topic it belongs to: invisible (no listing, no UI, no
  // expiry), and if a topic of this name is recreated later, its one recoverable level is a body
  // from the deleted topic's PREVIOUS lifetime rather than nothing.
  it('deleteTopic removes the backup along with the topic', () => {
    applyMemoryWrite(argusHome, 'NAV-1', {
      topic: 'dlt',
      content: 'first fact',
      scope: 'preference'
    })
    applyMemoryWrite(argusHome, 'NAV-1', {
      topic: 'dlt',
      content: 'second fact',
      scope: 'preference'
    })
    expect(fs.existsSync(bak('dlt'))).toBe(true)
    deleteTopic(argusHome, 'dlt')
    expect(fs.existsSync(bak('dlt'))).toBe(false)
  })

  it('deleteTopic on a topic that was never replaced (no backup) does not throw', () => {
    applyMemoryWrite(argusHome, 'NAV-1', {
      topic: 'dlt',
      content: 'only fact',
      scope: 'preference'
    })
    expect(fs.existsSync(bak('dlt'))).toBe(false)
    expect(() => deleteTopic(argusHome, 'dlt')).not.toThrow()
  })

  it('stamps the scope into the topic frontmatter', () => {
    applyMemoryWrite(argusHome, 'NAV-1', { topic: 'dlt', content: 'a fact', scope: 'correction' })
    const raw = readTopic(argusHome, 'dlt')
    expect(fmField(fmBlock(raw)!.fm, 'scope')).toBe('correction')
    expect(fmBlock(raw)!.body).toContain('a fact')
  })

  it('rewrites the scope stamp on a later write with a different scope', () => {
    applyMemoryWrite(argusHome, 'NAV-1', { topic: 'dlt', content: 'a', scope: 'correction' })
    applyMemoryWrite(argusHome, 'NAV-1', { topic: 'dlt', content: 'b', scope: 'preference' })
    const raw = readTopic(argusHome, 'dlt')
    expect(fmField(fmBlock(raw)!.fm, 'scope')).toBe('preference')
    expect(raw.match(/scope:/g)).toHaveLength(1)
  })

  // The normal read-modify-write shape: read_memory hands back the raw file (stamp included),
  // and the model is expected to pass that merged text straight back in as `content`. Pins that
  // withFrontmatter overlays rather than duplicates the key when content already has one.
  it('accepts content that already carries a stamped frontmatter block without doubling the scope line', () => {
    applyMemoryWrite(argusHome, 'NAV-1', {
      topic: 'dlt',
      content: 'first fact',
      scope: 'correction'
    })
    const stamped = readTopic(argusHome, 'dlt') // "---\nscope: correction\n---\nfirst fact\n"
    applyMemoryWrite(argusHome, 'NAV-1', { topic: 'dlt', content: stamped, scope: 'preference' })
    const raw = readTopic(argusHome, 'dlt')
    expect(raw.match(/scope:/g)).toHaveLength(1)
    expect(fmField(fmBlock(raw)!.fm, 'scope')).toBe('preference')
    expect(fmBlock(raw)!.body).toContain('first fact')
  })

  // The NEXT task caps write_memory content at 4096 bytes measured off this same field — an
  // accidental revert to Buffer.byteLength(content) (pre-stamp) would silently undercount and
  // stay green everywhere else.
  it('audit bytes reflect the final stamped body on disk, not the raw content argument', () => {
    const content = 'a fact'
    applyMemoryWrite(argusHome, 'NAV-1', { topic: 'dlt', content, scope: 'correction' })
    const onDisk = fs.statSync(path.join(argusHome, 'memory', 'dlt.md')).size
    const audit = readAudit(argusHome, 10)
    expect(audit[0].bytes).toBe(onDisk)
    expect(audit[0].bytes).toBeGreaterThan(Buffer.byteLength(content, 'utf8'))
  })
})

describe('the per-topic byte cap', () => {
  /** Content whose STAMPED body lands on exactly `target` bytes. The stamp is pure ASCII and
   *  so is the filler, so byte length == character length here. */
  const contentForBody = (target: number): string => {
    const overhead = Buffer.byteLength(withFrontmatter('\n', { scope: 'preference' }), 'utf8') - 1
    return 'x'.repeat(target - overhead - 1) // -1 for the trailing newline applyMemoryWrite adds
  }

  it('accepts a body of exactly the cap and rejects one byte more', () => {
    applyMemoryWrite(argusHome, 'NAV-1', {
      topic: 'at-cap',
      content: contentForBody(MEMORY_TOPIC_MAX_BYTES),
      scope: 'preference'
    })
    expect(Buffer.byteLength(readTopic(argusHome, 'at-cap'), 'utf8')).toBe(MEMORY_TOPIC_MAX_BYTES)

    expect(() =>
      applyMemoryWrite(argusHome, 'NAV-1', {
        topic: 'over-cap',
        content: contentForBody(MEMORY_TOPIC_MAX_BYTES + 1),
        scope: 'preference'
      })
    ).toThrow(/over the 4096-byte/)
  })

  it('measures the cap AFTER the frontmatter stamp', () => {
    // Just under the cap as raw content, over it once stamped.
    const content = 'x'.repeat(MEMORY_TOPIC_MAX_BYTES - 2)
    expect(Buffer.byteLength(content, 'utf8')).toBeLessThan(MEMORY_TOPIC_MAX_BYTES)
    expect(() =>
      applyMemoryWrite(argusHome, 'NAV-1', { topic: 'stamped', content, scope: 'preference' })
    ).toThrow(/over the 4096-byte/)
  })

  it('counts bytes, not characters — multi-byte content is measured as UTF-8', () => {
    // '—' is 3 bytes; 1400 of them are well under the cap by character count and over it by bytes.
    expect(() =>
      applyMemoryWrite(argusHome, 'NAV-1', {
        topic: 'multibyte',
        content: '—'.repeat(1400),
        scope: 'preference'
      })
    ).toThrow(/over the 4096-byte/)
  })

  it('writes NOTHING when the cap rejects: no topic, no .bak, no index line, no audit', () => {
    applyMemoryWrite(argusHome, 'NAV-1', {
      topic: 'dlt',
      content: 'small original',
      scope: 'preference',
      indexEntry: 'the original entry'
    })
    const auditBefore = readAudit(argusHome, 100).length
    expect(() =>
      applyMemoryWrite(argusHome, 'NAV-1', {
        topic: 'dlt',
        content: 'y'.repeat(MEMORY_TOPIC_MAX_BYTES + 100),
        scope: 'preference',
        indexEntry: 'a replacement entry'
      })
    ).toThrow(/over the 4096-byte/)
    expect(readTopic(argusHome, 'dlt')).toContain('small original')
    expect(fs.existsSync(path.join(argusHome, 'memory', '.bak', 'dlt.md'))).toBe(false)
    expect(readAudit(argusHome, 100).length).toBe(auditBefore)
  })

  it('leaves _index.md untouched when a NEW topic is rejected over cap', () => {
    applyMemoryWrite(argusHome, 'NAV-1', {
      topic: 'kept',
      content: 'k',
      scope: 'preference',
      indexEntry: 'kept lesson'
    })
    const before = readIndex(argusHome)
    expect(() =>
      applyMemoryWrite(argusHome, 'NAV-1', {
        topic: 'huge',
        content: 'y'.repeat(MEMORY_TOPIC_MAX_BYTES + 100),
        scope: 'preference',
        indexEntry: 'never lands'
      })
    ).toThrow(/over the 4096-byte/)
    expect(readIndex(argusHome)).toBe(before)
    expect(readIndex(argusHome)).not.toContain('huge')
  })

  it('names both alternative destinations in the rejection', () => {
    expect(() =>
      applyMemoryWrite(argusHome, 'NAV-1', {
        topic: 'huge',
        content: 'y'.repeat(MEMORY_TOPIC_MAX_BYTES + 100),
        scope: 'preference'
      })
    ).toThrow(/reference-edit/)
    expect(() =>
      applyMemoryWrite(argusHome, 'NAV-1', {
        topic: 'huge',
        content: 'y'.repeat(MEMORY_TOPIC_MAX_BYTES + 100),
        scope: 'preference'
      })
    ).toThrow(/append_finding/)
  })
})

describe('listTopics reports the stored scope', () => {
  it("reads the scope out of a topic's frontmatter", () => {
    applyMemoryWrite(argusHome, 'NAV-1', { topic: 'dlt', content: 'x', scope: 'environment' })
    expect(listTopics(argusHome).find((t) => t.name === 'dlt')?.scope).toBe('environment')
  })

  it('reports null for a hand-created topic with no frontmatter', () => {
    writeTopicFile(argusHome, 'legacy', 'just a body, no frontmatter\n')
    expect(listTopics(argusHome).find((t) => t.name === 'legacy')?.scope).toBeNull()
  })

  it('reports null for a frontmatter block with an unrecognised scope value', () => {
    writeTopicFile(argusHome, 'weird', '---\nscope: workflow\n---\nbody\n')
    expect(listTopics(argusHome).find((t) => t.name === 'weird')?.scope).toBeNull()
  })

  // A single unreadable topic file must cost that topic its chip, not take down the whole list —
  // listTopics backs memoryTopicsPayload (5 IPC handlers) and usageStats, so an unguarded throw
  // here would blank the entire Memory settings page over one bad file. A directory named
  // `<topic>.md` makes statSync succeed but readFileSync throw EISDIR (confirmed on this
  // machine — same trick as clearFindings.test.ts's "propagates a non-ENOENT" case).
  it('keeps other topics visible when one topic file is unreadable, reporting scope: null for it', () => {
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => undefined)
    try {
      applyMemoryWrite(argusHome, 'NAV-1', { topic: 'good', content: 'x', scope: 'environment' })
      fs.mkdirSync(path.join(memoryDir(argusHome), 'bad.md'))
      const topics = listTopics(argusHome)
      expect(topics.map((t) => t.name).sort()).toEqual(['bad', 'good'])
      expect(topics.find((t) => t.name === 'good')?.scope).toBe('environment')
      expect(topics.find((t) => t.name === 'bad')?.scope).toBeNull()
      expect(warnSpy).toHaveBeenCalled()
    } finally {
      warnSpy.mockRestore()
    }
  })
})
