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
import { packManifestSchema } from '../../../app/src/main/services/packs/manifest'

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

  it('skips the file check for a binary declared bundled: false and warns instead of throwing', () => {
    const m = readManifest(SAMPLE)
    m.binaries[0].bundled = false
    m.binaries[0].fixHint = 'install argus-demo yourself'
    const empty = tmpDir()
    const { warnings } = crossCheckBinaries(m, empty, 'mac-arm64')
    expect(warnings.join()).toMatch(/argus-demo/)
    expect(warnings.join()).toMatch(/bundled: false/)
  })
})

describe('crossCheckBinaries — --bin subdirectory', () => {
  it('fails loudly when --bin contains a subdirectory instead of silently dropping it', () => {
    const m = readManifest(SAMPLE)
    const dir = tmpDir()
    fs.writeFileSync(path.join(dir, 'argus-demo'), 'x')
    fs.mkdirSync(path.join(dir, 'lib'))
    fs.writeFileSync(path.join(dir, 'lib', 'helper.so'), 'x')
    expect(() => crossCheckBinaries(m, dir, 'mac-arm64')).toThrow(/lib/)
  })

  it('fails loudly when --bin contains a symlinked directory (lstat sees neither file nor dir)', () => {
    const m = readManifest(SAMPLE)
    const dir = tmpDir()
    fs.writeFileSync(path.join(dir, 'argus-demo'), 'x')
    // The real directory lives OUTSIDE binDir — only a symlink to it sits inside
    // binDir, so the existing plain-directory guard cannot accidentally catch this
    // via the literal 'real-lib' entry (a stray substring match would make this
    // test pass for the wrong reason).
    const target = path.join(tmpDir(), 'external-target')
    fs.mkdirSync(target)
    fs.writeFileSync(path.join(target, 'helper.so'), 'x')
    const link = path.join(dir, 'symlinked-dir')
    fs.symlinkSync(target, link, process.platform === 'win32' ? 'junction' : 'dir')
    expect(() => crossCheckBinaries(m, dir, 'mac-arm64')).toThrow(/symlinked-dir/)
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

  it('excludes node_modules (and other dev-artifact dirs) from BUNDLE_DIRS copies', () => {
    const m = packManifestSchema.parse({ id: 'x', displayName: 'X', version: '1.0.0', argusApi: '^1' })
    const packDir = tmpDir()
    fs.mkdirSync(path.join(packDir, 'ui', 'node_modules'), { recursive: true })
    fs.writeFileSync(path.join(packDir, 'ui', 'node_modules', 'junk.txt'), 'x')
    fs.writeFileSync(path.join(packDir, 'ui', 'real.txt'), 'keep me')

    const staging = tmpDir()
    assembleBundle(m, packDir, BIN, 'mac-arm64', staging)

    expect(fs.existsSync(path.join(staging, 'ui', 'node_modules'))).toBe(false)
    expect(fs.existsSync(path.join(staging, 'ui', 'real.txt'))).toBe(true)
  })

  // The real case: a panel is its own npm project several levels down, so the filter
  // has to bite below the top level of a BUNDLE_DIR too.
  it('excludes node_modules nested below the top level of a bundle dir', () => {
    const m = readManifest(SAMPLE)
    const pack = tmpDir()
    fs.cpSync(SAMPLE, pack, { recursive: true })
    const panel = path.join(pack, 'ui', 'panel')
    fs.mkdirSync(path.join(panel, 'node_modules', 'left-pad'), { recursive: true })
    fs.writeFileSync(path.join(panel, 'node_modules', 'left-pad', 'index.js'), 'dev dep')
    fs.writeFileSync(path.join(panel, 'index.html'), '<h1>panel</h1>')
    fs.mkdirSync(path.join(pack, 'skills', 'demo', 'tool', 'node_modules'), { recursive: true })
    fs.writeFileSync(path.join(pack, 'skills', 'demo', 'tool', 'node_modules', 'x.js'), 'dev dep')

    const staging = tmpDir()
    assembleBundle(m, pack, BIN, 'mac-arm64', staging)

    expect(fs.existsSync(path.join(staging, 'ui', 'panel', 'index.html'))).toBe(true)
    expect(fs.existsSync(path.join(staging, 'ui', 'panel', 'node_modules'))).toBe(false)
    expect(fs.existsSync(path.join(staging, 'skills', 'demo', 'tool', 'node_modules'))).toBe(false)
  })

  it('warns naming each dev artifact it skipped, so the build output shows it', () => {
    const m = readManifest(SAMPLE)
    const pack = tmpDir()
    fs.cpSync(SAMPLE, pack, { recursive: true })
    fs.mkdirSync(path.join(pack, 'ui', 'panel', 'node_modules'), { recursive: true })
    fs.writeFileSync(path.join(pack, 'ui', 'panel', 'node_modules', 'x.js'), 'dev dep')

    const staging = tmpDir()
    const { warnings } = assembleBundle(m, pack, BIN, 'mac-arm64', staging)
    expect(warnings.join('\n')).toMatch(/ui\/panel\/node_modules/)
  })

  it('reports the skip through build() so the CLI prints it', async () => {
    const pack = tmpDir()
    fs.cpSync(SAMPLE, pack, { recursive: true })
    fs.mkdirSync(path.join(pack, 'ui', 'panel', 'node_modules'), { recursive: true })
    fs.writeFileSync(path.join(pack, 'ui', 'panel', 'node_modules', 'x.js'), 'dev dep')

    const res = await build({ packDir: pack, binDir: BIN, platform: 'mac-arm64', outDir: tmpDir() })
    expect(res.warnings.join('\n')).toMatch(/node_modules/)
    expect(res.files.some((f) => f.includes('node_modules'))).toBe(false)
  })

  it('creates an empty bin/ instead of throwing when --bin does not exist', () => {
    const m = packManifestSchema.parse({ id: 'x', displayName: 'X', version: '1.0.0', argusApi: '^1' })
    const packDir = tmpDir()
    const staging = tmpDir()
    const missingBin = path.join(tmpDir(), 'does-not-exist')

    expect(() => assembleBundle(m, packDir, missingBin, 'mac-arm64', staging)).not.toThrow()
    expect(fs.existsSync(path.join(staging, 'bin'))).toBe(true)
    expect(fs.readdirSync(path.join(staging, 'bin'))).toEqual([])
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

  it('reports the total file count and byte size of what it zipped', async () => {
    const out = tmpDir()
    const res = await build({ packDir: SAMPLE, binDir: BIN, platform: 'mac-arm64', outDir: out })

    const dest = tmpDir()
    await extract(res.zipPath, dest)
    const expectedBytes = res.files.reduce(
      (sum, rel) => sum + fs.statSync(path.join(dest, ...rel.split('/'))).size,
      0
    )
    expect(res.totalBytes).toBe(expectedBytes)
    expect(res.totalBytes).toBeGreaterThan(0)
  })

  it('fails loudly on a --bin subdirectory rather than shipping an incomplete bundle', async () => {
    const dir = tmpDir()
    fs.writeFileSync(path.join(dir, 'argus-demo'), 'x')
    fs.mkdirSync(path.join(dir, 'launcher'))
    const out = tmpDir()
    await expect(
      build({ packDir: SAMPLE, binDir: dir, platform: 'mac-arm64', outDir: out })
    ).rejects.toThrow(/launcher/)
  })

  it('builds successfully with an empty bin/ when a pack has no bundled binaries and --bin does not exist', async () => {
    const packDir = tmpDir()
    const manifest = packManifestSchema.parse({
      id: 'nobin',
      displayName: 'No Bin',
      version: '1.0.0',
      argusApi: '^1'
    })
    fs.writeFileSync(path.join(packDir, 'argus-pack.json'), JSON.stringify(manifest, null, 2))
    const missingBin = path.join(tmpDir(), 'does-not-exist')
    const out = tmpDir()

    // Must not throw the raw ENOENT that a real user-provided-binaries pack (all
    // binaries `bundled: false`, so nothing to point --bin at) would otherwise hit.
    const res = await build({ packDir, binDir: missingBin, platform: 'mac-arm64', outDir: out })
    expect(fs.existsSync(res.zipPath)).toBe(true)
    // Nothing was copied into bin/ — no bin/* entry made it into the bundle.
    // (zip-lib's walker only enumerates files, so an empty directory isn't stored
    // as its own zip entry; asserting on res.files is the reliable round-trip check.)
    expect(res.files.some((f) => f.startsWith('bin/'))).toBe(false)

    const dest = tmpDir()
    await extract(res.zipPath, dest)
    expect(fs.existsSync(path.join(dest, 'argus-pack.json'))).toBe(true)
  })
})
