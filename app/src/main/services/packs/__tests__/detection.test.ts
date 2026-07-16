import { describe, it, expect } from 'vitest'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import zlib from 'node:zlib'
import { createDetection } from '../detection'
import { PackRegistry } from '../registry'
import { packManifestSchema } from '../manifest'
import { samplePackRegistry } from './fixtures'

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'argus-detect-'))
function write(name: string, data: Buffer | string): string {
  const p = path.join(dir, name)
  fs.writeFileSync(p, data)
  return p
}

describe('createDetection with nav-style rules (ported detect.test.ts)', () => {
  const det = createDetection(samplePackRegistry())

  it('detects history recordings (.rec.gz)', () => {
    expect(det.detectType(write('session.rec.gz', zlib.gzipSync(Buffer.from('x'))))).toBe(
      'archive-rec'
    )
  })
  it('detects generic gzip as archive', () => {
    expect(det.detectType(write('logs.tar.gz', zlib.gzipSync(Buffer.from('x'))))).toBe('archive')
  })
  it('detects binlog by magic', () => {
    expect(
      det.detectType(
        write('trace.bin', Buffer.concat([Buffer.from('\x44\x4C\x54\x01'), Buffer.alloc(16)]))
      )
    ).toBe('binlog')
  })
  it('detects zip archives', () => {
    expect(det.detectType(write('bundle.zip', Buffer.from([0x50, 0x4b, 0x03, 0x04, 0, 0])))).toBe(
      'archive'
    )
  })
  it('detects PNG screenshots', () => {
    expect(
      det.detectType(
        write('shot.png', Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))
      )
    ).toBe('screenshot')
  })
  it('detects list-json', () => {
    expect(det.detectType(write('conv.list.json', JSON.stringify({ events: [] })))).toBe(
      'list-json'
    )
  })
  it('detects applog', () => {
    expect(
      det.detectType(write('log.txt', '07-08 14:23:01.123  1234  1234 I AppService: created\n'))
    ).toBe('applog')
  })
  it('detects tagged traces by filename', () => {
    expect(
      det.detectType(write('session-tagged-json.json', JSON.stringify({ version: 1, events: [] })))
    ).toBe('tagged-json')
  })
  it('detects tagged traces by top-level key', () => {
    expect(
      det.detectType(
        write('nav-session.json', JSON.stringify({ tagged: { version: 1 }, events: [] }))
      )
    ).toBe('tagged-json')
  })
  it('keeps plain json as list-json/text', () => {
    expect(det.detectType(write('plain.json', JSON.stringify({ hello: 1 })))).not.toBe(
      'tagged-json'
    )
  })
  it('falls back to text then unknown', () => {
    expect(det.detectType(write('notes.md', 'just some notes\n'))).toBe('text')
    expect(det.detectType(write('blob.bin', Buffer.from([0, 1, 2, 3, 0, 5])))).toBe('unknown')
  })

  // Deliberate deviations from the old detect.ts (pack rules now precede generic archives):
  it('DEVIATION: zip-magic .bintrace.zip is bintrace (was archive)', () => {
    expect(
      det.detectType(write('bundle.bintrace.zip', Buffer.from([0x50, 0x4b, 0x03, 0x04, 0, 0])))
    ).toBe('bintrace')
  })
  it('DEVIATION: gzip named .binlog is binlog (was archive)', () => {
    expect(det.detectType(write('weird.binlog', zlib.gzipSync(Buffer.from('x'))))).toBe('binlog')
  })
  it('DEVIATION: .list.json with tagged marker is tagged-json (was list-json)', () => {
    expect(det.detectType(write('report-tagged.list.json', JSON.stringify({ version: 1 })))).toBe(
      'tagged-json'
    )
  })

  it('isText covers text + declared isText types only', () => {
    expect(det.isText('text')).toBe(true)
    expect(det.isText('applog')).toBe(true)
    expect(det.isText('tagged-json')).toBe(true)
    expect(det.isText('binlog')).toBe(false)
    expect(det.isText('archive')).toBe(false)
  })

  it('compoundExts derives multi-dot suffixes plus .tar.gz', () => {
    const exts = det.compoundExts()
    expect(exts).toContain('.rec.gz')
    expect(exts).toContain('.bintrace.zip')
    expect(exts).toContain('.list.json')
    expect(exts).toContain('.tar.gz')
    expect(exts).not.toContain('.binlog')
  })

  it('artifactMeta lists pack detectors first, then generics', () => {
    const meta = det.artifactMeta()
    expect(meta[0]).toEqual({
      type: 'binlog',
      displayName: 'Binary log',
      analyzeSkill: 'analyze-binlog',
      isText: false
    })
    const types = meta.map((m) => m.type)
    for (const g of ['archive', 'screenshot', 'text', 'unknown']) expect(types).toContain(g)
  })
})

describe('createDetection with no registry (generics only)', () => {
  const det = createDetection()
  it('types only generic outcomes', () => {
    expect(det.detectType(write('g.rec.gz', zlib.gzipSync(Buffer.from('x'))))).toBe('archive')
    expect(det.detectType(write('t.binlog', 'plain text content'))).toBe('text')
    expect(det.compoundExts()).toEqual(['.tar.gz'])
  })
  it('an invalid headRegex in a rule is skipped with a warning, not fatal', () => {
    const manifest = packManifestSchema.parse({
      id: 'bad',
      displayName: 'B',
      version: '1',
      argusApi: '^1',
      detectors: [
        { type: 'weird', match: [{ headRegex: { source: '(' } }, { nameEndsWith: ['.weird'] }] }
      ]
    })
    const reg = new PackRegistry([
      {
        id: 'bad',
        dir: '/p/bad',
        manifest,
        personaText: null,
        skillsDir: null,
        referencesDir: null,
        uiDir: null
      }
    ])
    const d = createDetection(reg)
    expect(d.detectType(write('x.weird', 'abc'))).toBe('weird') // second rule still works
  })

  it('a detector whose every rule is invalid is dropped entirely', () => {
    const manifest = packManifestSchema.parse({
      id: 'bad2',
      displayName: 'B',
      version: '1',
      argusApi: '^1',
      detectors: [{ type: 'ghost', match: [{ headRegex: { source: '(' } }] }]
    })
    const reg = new PackRegistry([
      {
        id: 'bad2',
        dir: '/p/bad2',
        manifest,
        personaText: null,
        skillsDir: null,
        referencesDir: null,
        uiDir: null
      }
    ])
    const d = createDetection(reg)
    expect(d.detectType(write('x.ghost', 'abc'))).toBe('text') // falls through to generics
    // compileDetectors filters out detectors with zero valid rules, so artifactMeta (which maps
    // over the same `compiled` list) never lists a fully-dropped detector either — declaration
    // survives Zod parsing, but detection.ts drops it before it's exposed anywhere.
    expect(d.artifactMeta().some((m) => m.type === 'ghost')).toBe(false)
  })
})
