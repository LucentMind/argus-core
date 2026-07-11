import { describe, it, expect } from 'vitest'
import path from 'node:path'
import fs from 'node:fs'
import os from 'node:os'
import { readManifest, crossCheckBinaries, osOf, assembleBundle } from '../src/build'

const FIX = path.join(__dirname, 'fixtures')
const SAMPLE = path.join(FIX, 'sample-pack')
const BIN = path.join(FIX, 'bin')

function tmpDir(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'packtools-'))
}

describe('readManifest', () => {
  it('reads and validates the sample manifest', () => {
    const m = readManifest(SAMPLE)
    expect(m.id).toBe('sample')
    expect(m.binaries[0].id).toBe('argus-demo')
  })

  it('throws when the manifest is missing', () => {
    expect(() => readManifest(FIX)).toThrow(/argus-pack\.json/)
  })
})

describe('osOf', () => {
  it('maps <os>-<arch> prefixes', () => {
    expect(osOf('mac-arm64')).toBe('darwin')
    expect(osOf('win-x64')).toBe('win32')
    expect(osOf('linux-x64')).toBe('linux')
  })
  it('throws on an unknown os', () => {
    expect(() => osOf('bsd-x64')).toThrow()
  })
})

describe('crossCheckBinaries', () => {
  it('passes when every applicable binary has a file', () => {
    const m = readManifest(SAMPLE)
    const { warnings } = crossCheckBinaries(m, BIN, 'mac-arm64')
    expect(warnings).toEqual([])
  })

  it('throws when a required binary file is missing', () => {
    const m = readManifest(SAMPLE)
    const empty = tmpDir()
    expect(() => crossCheckBinaries(m, empty, 'mac-arm64')).toThrow(/argus-demo/)
  })

  it('warns about an extra file no binary claims', () => {
    const m = readManifest(SAMPLE)
    const dir = tmpDir()
    fs.writeFileSync(path.join(dir, 'argus-demo'), 'x')
    fs.writeFileSync(path.join(dir, 'stray-file'), 'x')
    const { warnings } = crossCheckBinaries(m, dir, 'mac-arm64')
    expect(warnings.join()).toMatch(/stray-file/)
  })

  it('skips a binary that does not apply to the target platform', () => {
    const m = readManifest(SAMPLE)
    m.binaries[0].platforms = ['win32'] // demo binary is Windows-only
    const empty = tmpDir()
    expect(() => crossCheckBinaries(m, empty, 'mac-arm64')).not.toThrow()
  })
})

describe('assembleBundle', () => {
  it('stages manifest (platform-stamped), persona, skills, references, and bin/', () => {
    const m = readManifest(SAMPLE)
    const staging = tmpDir()
    assembleBundle(m, SAMPLE, BIN, 'mac-arm64', staging)

    const stamped = JSON.parse(fs.readFileSync(path.join(staging, 'argus-pack.json'), 'utf8'))
    expect(stamped.platform).toBe('mac-arm64')
    expect(fs.existsSync(path.join(staging, 'persona.md'))).toBe(true)
    expect(fs.existsSync(path.join(staging, 'skills', 'demo', 'SKILL.md'))).toBe(true)
    expect(fs.existsSync(path.join(staging, 'references', 'demo.md'))).toBe(true)
    expect(fs.existsSync(path.join(staging, 'bin', 'argus-demo'))).toBe(true)
  })

  it('does not copy bin-src, .git, or other non-bundle content', () => {
    const m = readManifest(SAMPLE)
    const staging = tmpDir()
    assembleBundle(m, SAMPLE, BIN, 'mac-arm64', staging)
    expect(fs.existsSync(path.join(staging, 'bin-src'))).toBe(false)
  })
})
