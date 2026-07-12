import { describe, it, expect } from 'vitest'
import path from 'node:path'
import fs from 'node:fs'
import os from 'node:os'
import crypto from 'node:crypto'
import { extract } from 'zip-lib'
import {
  readManifest,
  crossCheckBinaries,
  osOf,
  assembleBundle,
  writeChecksums,
  zipBundle,
  build
} from '../src/build'

const FIX = path.join(__dirname, 'fixtures')
const SAMPLE = path.join(FIX, 'sample-pack')
const BIN = path.join(FIX, 'bin')

function tmpDir(): string {
  // realpathSync: on macOS os.tmpdir() is /var/folders/... (a symlink to
  // /private/var/...); zip-lib's extract guard compares an extracted file's
  // realpath against the unresolved dest and rejects the mismatch, failing the
  // end-to-end "verifiable named zip" test that extracts into a tmpDir().
  return fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'packtools-')))
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

describe('writeChecksums', () => {
  it('hashes every bundle file with POSIX paths, sorted, LF', () => {
    const m = readManifest(SAMPLE)
    const staging = tmpDir()
    assembleBundle(m, SAMPLE, BIN, 'mac-arm64', staging)
    const map = writeChecksums(staging)

    const text = fs.readFileSync(path.join(staging, 'CHECKSUMS'), 'utf8')
    expect(text).not.toMatch(/\r/) // LF only
    const lines = text.trimEnd().split('\n')
    // sorted by path
    const paths = lines.map((l) => l.split('  ')[1])
    expect(paths).toEqual([...paths].sort())
    // includes a declarative file and the binary; excludes CHECKSUMS itself
    expect(paths).toContain('argus-pack.json')
    expect(paths).toContain('bin/argus-demo')
    expect(paths).not.toContain('CHECKSUMS')

    // hash of the binary matches
    const expected = crypto
      .createHash('sha256')
      .update(fs.readFileSync(path.join(staging, 'bin', 'argus-demo')))
      .digest('hex')
    expect(map['bin/argus-demo']).toBe(expected)
  })
})

describe('build (end-to-end)', () => {
  it('throws on a malformed --platform (missing arch)', async () => {
    const out = tmpDir()
    await expect(build({ packDir: SAMPLE, binDir: BIN, platform: 'mac', outDir: out })).rejects.toThrow()
  })

  it('produces a verifiable named zip', async () => {
    const out = tmpDir()
    const res = await build({ packDir: SAMPLE, binDir: BIN, platform: 'mac-arm64', outDir: out })

    expect(res.bundleName).toBe('sample-0.1.0-mac-arm64')
    expect(res.zipPath).toBe(path.join(out, 'sample-0.1.0-mac-arm64.zip'))
    expect(fs.existsSync(res.zipPath)).toBe(true)

    // Re-open and verify layout + a checksum.
    const dest = tmpDir()
    await extract(res.zipPath, dest)
    const stamped = JSON.parse(fs.readFileSync(path.join(dest, 'argus-pack.json'), 'utf8'))
    expect(stamped.platform).toBe('mac-arm64')
    expect(fs.existsSync(path.join(dest, 'CHECKSUMS'))).toBe(true)
    expect(fs.existsSync(path.join(dest, 'bin', 'argus-demo'))).toBe(true)

    const checks = fs.readFileSync(path.join(dest, 'CHECKSUMS'), 'utf8').trimEnd().split('\n')
    const line = checks.find((l) => l.endsWith('  bin/argus-demo'))!
    const [hex] = line.split('  ')
    const actual = crypto
      .createHash('sha256')
      .update(fs.readFileSync(path.join(dest, 'bin', 'argus-demo')))
      .digest('hex')
    expect(hex).toBe(actual)
  })
})
