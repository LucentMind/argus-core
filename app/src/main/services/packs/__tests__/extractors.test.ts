import { describe, it, expect, beforeEach } from 'vitest'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { createExtractors } from '../extractors'
import { BinariesService } from '../binaries'
import { PackRegistry } from '../registry'
import { packManifestSchema } from '../manifest'
import type { LoadedPack } from '../loader'

let tmp: string
beforeEach(() => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'argus-extract-'))
})

function pack(binaries: unknown[], detectors: unknown[]): LoadedPack {
  const manifest = packManifestSchema.parse({
    id: 'testpack',
    displayName: 'T',
    version: '1',
    argusApi: '^1',
    binaries,
    detectors
  })
  return {
    id: 'testpack',
    dir: tmp,
    manifest,
    personaText: null,
    skillsDir: null,
    referencesDir: null
  }
}

function mkExe(dir: string, name: string): string {
  fs.mkdirSync(dir, { recursive: true })
  const p = path.join(dir, process.platform === 'win32' ? `${name}.exe` : name)
  fs.writeFileSync(p, '')
  return p
}

describe('createExtractors', () => {
  it('resolves an exe-backed extract to the resolved binary path', () => {
    const bin = mkExe(path.join(tmp, 'out'), 'fake-parse')
    const reg = new PackRegistry([
      pack(
        [
          {
            id: 'fake-parse',
            kind: 'exe',
            displayName: 'F',
            names: ['fake-parse'],
            devPaths: ['out']
          }
        ],
        [
          {
            type: 'binlog',
            match: [{ nameEndsWith: ['.binlog'] }],
            extract: { bin: 'fake-parse', args: ['binlog-to-text', '{input}', '--output', '{output}'] }
          }
        ]
      )
    ])
    const svc = new BinariesService({ registry: reg, settingsTools: () => ({}), capturedEnv: {} })
    const ex = createExtractors(reg, svc)
    expect(ex.extractFor('binlog')).toEqual({
      command: bin,
      args: ['binlog-to-text', '{input}', '--output', '{output}']
    })
  })

  it('resolves a pathDir-backed extract to the bare executable name', () => {
    const reg = new PackRegistry([
      pack(
        [{ id: 'fake-trace', kind: 'pathDir', displayName: 'T', names: ['fake-trace'] }],
        [
          {
            type: 'bintrace',
            match: [{ nameEndsWith: ['.bintrace'] }],
            extract: { bin: 'fake-trace', args: ['convert', '{input}'] }
          }
        ]
      )
    ])
    const svc = new BinariesService({ registry: reg, settingsTools: () => ({}), capturedEnv: {} })
    expect(createExtractors(reg, svc).extractFor('bintrace')).toEqual({
      command: 'fake-trace',
      args: ['convert', '{input}']
    })
  })

  it('returns null for unresolved exe, unknown bin id, no-extract detector, unknown type', () => {
    const reg = new PackRegistry([
      pack(
        [{ id: 'gone', kind: 'exe', displayName: 'G', names: ['gone-bin'] }],
        [
          { type: 'a', match: [{ nameEndsWith: ['.a'] }], extract: { bin: 'gone', args: ['x'] } },
          {
            type: 'b',
            match: [{ nameEndsWith: ['.b'] }],
            extract: { bin: 'nonexistent-id', args: ['x'] }
          },
          { type: 'c', match: [{ nameEndsWith: ['.c'] }] }
        ]
      )
    ])
    const svc = new BinariesService({ registry: reg, settingsTools: () => ({}), capturedEnv: {} })
    const ex = createExtractors(reg, svc)
    expect(ex.extractFor('a')).toBeNull() // exe declared but not resolved on disk
    expect(ex.extractFor('b')).toBeNull() // extract.bin references no declared binary
    expect(ex.extractFor('c')).toBeNull() // detector has no extract
    expect(ex.extractFor('zzz')).toBeNull() // unknown type
  })
})
