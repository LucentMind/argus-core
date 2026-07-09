import { describe, it, expect } from 'vitest'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import zlib from 'node:zlib'
import { detectArtifactType } from '../detect'

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'argus-detect-'))
function write(name: string, data: Buffer | string): string {
  const p = path.join(dir, name)
  fs.writeFileSync(p, data)
  return p
}

describe('detectArtifactType', () => {
  it('detects history recordings (.rec.gz)', () => {
    const p = write('session.rec.gz', zlib.gzipSync(Buffer.from('x')))
    expect(detectArtifactType(p)).toBe('archive-rec')
  })
  it('detects generic gzip as archive', () => {
    const p = write('logs.tar.gz', zlib.gzipSync(Buffer.from('x')))
    expect(detectArtifactType(p)).toBe('archive')
  })
  it('detects BINLOG by magic', () => {
    const p = write('trace.bin', Buffer.concat([Buffer.from('BINLOG\x01'), Buffer.alloc(16)]))
    expect(detectArtifactType(p)).toBe('binlog')
  })
  it('detects zip archives', () => {
    const p = write('bundle.zip', Buffer.from([0x50, 0x4b, 0x03, 0x04, 0, 0]))
    expect(detectArtifactType(p)).toBe('archive')
  })
  it('detects PNG screenshots', () => {
    const p = write('shot.png', Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))
    expect(detectArtifactType(p)).toBe('screenshot')
  })
  it('detects list-json', () => {
    const p = write('conv.list.json', JSON.stringify({ events: [] }))
    expect(detectArtifactType(p)).toBe('list-json')
  })
  it('detects applog', () => {
    const p = write(
      'log.txt',
      '07-08 14:23:01.123  1234  1234 I HiveMindNavigator: created\n'
    )
    expect(detectArtifactType(p)).toBe('applog')
  })
  it('detects tagged traces by filename', () => {
    const p = write('session-tagged-json.json', JSON.stringify({ version: 1, events: [] }))
    expect(detectArtifactType(p)).toBe('tagged-json')
  })
  it('detects tagged traces by top-level key', () => {
    const p = write('nav-session.json', JSON.stringify({ tagged: { version: 1 }, events: [] }))
    expect(detectArtifactType(p)).toBe('tagged-json')
  })
  it('keeps plain json as list-json/text', () => {
    const p = write('plain.json', JSON.stringify({ hello: 1 }))
    expect(detectArtifactType(p)).not.toBe('tagged-json')
  })
  it('falls back to text then unknown', () => {
    expect(detectArtifactType(write('notes.md', 'just some notes\n'))).toBe('text')
    expect(detectArtifactType(write('blob.bin', Buffer.from([0, 1, 2, 3, 0, 5])))).toBe('unknown')
  })
})
