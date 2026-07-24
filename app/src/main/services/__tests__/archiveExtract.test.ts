import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { ZipFile } from 'yazl'
import { extractZipToTemp, type ArchiveLimits } from '../archiveExtract'

const LIMITS: ArchiveLimits = {
  maxDepth: 3,
  maxEntries: 1000,
  maxTotalBytes: 5 * 1024 ** 3,
  maxEntryBytes: 500 * 1024 ** 2,
  maxRatio: 100
}

let tmp: string
beforeEach(() => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'arx-'))
})
afterEach(() => {
  fs.rmSync(tmp, { recursive: true, force: true })
})

// Minimal raw-zip writer, used both for ordinary fixtures (files + directory
// entries) and for adversarial entry names an ordinary zip library won't produce.
// Note: yazl 3.3.1's own `validateMetadataPath` rejects '..' path segments
// (verified against node_modules/yazl/index.js), so we can't pass the evil
// name straight to addBuffer. Instead we write a same-length placeholder
// name through yazl, then byte-patch the compiled zip to swap in the
// literal traversal name — the name's byte length is unchanged, so the
// local-file-header / central-directory offsets stay valid.
function toPlaceholderName(name: string): string {
  return name
    .split('/')
    .map((seg) => (seg === '..' ? '__' : seg))
    .join('/')
    .replace(/^\//, '_')
}

async function makeZipRaw(
  zipPath: string,
  entries: Array<{ name: string; body: string | Buffer }>,
  directories: string[] = []
): Promise<void> {
  const zf = new ZipFile()
  const swaps = entries.map((e) => {
    const placeholder = toPlaceholderName(e.name)
    if (placeholder.length !== e.name.length) throw new Error('placeholder length mismatch')
    zf.addBuffer(Buffer.from(e.body), placeholder)
    return { placeholder, real: e.name }
  })
  for (const dir of directories) zf.addEmptyDirectory(dir)
  const chunks: Buffer[] = []
  await new Promise<void>((res, rej) => {
    zf.outputStream.on('data', (c: Buffer) => chunks.push(c))
    zf.outputStream.on('end', res)
    zf.outputStream.on('error', rej)
    zf.end()
  })
  let raw = Buffer.concat(chunks).toString('binary')
  for (const { placeholder, real } of swaps) raw = raw.split(placeholder).join(real)
  fs.writeFileSync(zipPath, Buffer.from(raw, 'binary'))
}

// Object-map convenience over makeZipRaw; supports Buffer bodies for size/ratio fixtures.
async function makeZip(zipPath: string, files: Record<string, string | Buffer>): Promise<void> {
  await makeZipRaw(
    zipPath,
    Object.entries(files).map(([name, body]) => ({ name, body }))
  )
}

describe('extractZipToTemp', () => {
  it('stages every file entry, skipping directory entries', async () => {
    const zipPath = path.join(tmp, 'a.zip')
    // Include a standalone empty-directory entry (via yazl's addEmptyDirectory)
    // so the 'entry' handler's directory-skip branch is actually exercised —
    // zip-lib-built archives never emit one on their own.
    await makeZipRaw(
      zipPath,
      [
        { name: 'logs/app.log', body: 'hello' },
        { name: 'notes.txt', body: 'world' }
      ],
      ['logs/']
    )
    const out = path.join(tmp, 'out')
    fs.mkdirSync(out)
    const { entries } = await extractZipToTemp(zipPath, out, LIMITS)
    const byInner = Object.fromEntries(entries.map((e) => [e.innerPath, e]))
    expect(Object.keys(byInner).sort()).toEqual(['logs/app.log', 'notes.txt'])
    expect(byInner['logs/']).toBeUndefined()
    expect(fs.readFileSync(byInner['logs/app.log'].tempPath, 'utf8')).toBe('hello')
    expect(entries.every((e) => e.depth === 0)).toBe(true)
  })

  it('rejects an entry whose name escapes the output dir', async () => {
    // A hand-crafted entry name via yazl (see makeZipRaw above).
    const evil = path.join(tmp, 'evil2.zip')
    await makeZipRaw(evil, [{ name: '../escape.txt', body: 'pwned' }])
    const out = path.join(tmp, 'o2')
    fs.mkdirSync(out)
    await expect(extractZipToTemp(evil, out, LIMITS)).rejects.toMatchObject({ kind: 'traversal' })
  })
})

// Build a zip whose single entry is another zip (built by makeZip). zip-lib is not
// a dependency of this test file (removed in Task 1) — we build the inner zip on
// disk with makeZip, then embed its raw bytes as a single entry body via
// makeZipRaw (widened to accept Buffer bodies in Task 2). yazl deflates the
// already-compressed inner zip ~1:1, well under LIMITS.maxRatio.
async function nestZip(
  outerPath: string,
  innerName: string,
  innerFiles: Record<string, string>
): Promise<void> {
  const innerPath = path.join(tmp, `inner-${path.basename(outerPath)}`)
  await makeZip(innerPath, innerFiles)
  const innerBytes = fs.readFileSync(innerPath)
  await makeZipRaw(outerPath, [{ name: innerName, body: innerBytes }])
}

describe('extractZipToTemp recursion', () => {
  it('recurses into a nested zip and flattens inner files with a path prefix', async () => {
    const outer = path.join(tmp, 'outer.zip')
    await nestZip(outer, 'bundle.zip', { 'crash.txt': 'boom' })
    const out = path.join(tmp, 'orc')
    fs.mkdirSync(out)
    const { entries } = await extractZipToTemp(outer, out, LIMITS)
    expect(entries).toHaveLength(1)
    expect(entries[0].innerPath).toBe('bundle.zip/crash.txt')
    expect(entries[0].depth).toBe(1)
    expect(fs.readFileSync(entries[0].tempPath, 'utf8')).toBe('boom')
  })

  it('does NOT recurse past maxDepth — a deeper zip is kept as an opaque entry', async () => {
    const outer = path.join(tmp, 'outer2.zip')
    await nestZip(outer, 'bundle.zip', { 'crash.txt': 'boom' })
    const out = path.join(tmp, 'od0')
    fs.mkdirSync(out)
    const { entries } = await extractZipToTemp(outer, out, { ...LIMITS, maxDepth: 0 })
    expect(entries).toHaveLength(1)
    expect(entries[0].innerPath).toBe('bundle.zip') // opaque — the inner zip itself
    expect(entries[0].depth).toBe(0)
  })
})

describe('extractZipToTemp caps', () => {
  it('throws entry-bytes when a single entry exceeds the per-entry cap', async () => {
    const zipPath = path.join(tmp, 'big.zip')
    await makeZip(zipPath, { 'big.bin': Buffer.alloc(2048, 0x41) }) // 2 KB of 'A'
    const out = path.join(tmp, 'ob')
    fs.mkdirSync(out)
    await expect(
      extractZipToTemp(zipPath, out, { ...LIMITS, maxEntryBytes: 1024 })
    ).rejects.toMatchObject({ kind: 'entry-bytes' })
  })

  it('throws total-bytes when the sum across entries exceeds the total cap', async () => {
    const zipPath = path.join(tmp, 'sum.zip')
    await makeZip(zipPath, { 'a.bin': Buffer.alloc(800, 1), 'b.bin': Buffer.alloc(800, 2) })
    const out = path.join(tmp, 'os')
    fs.mkdirSync(out)
    await expect(
      extractZipToTemp(zipPath, out, { ...LIMITS, maxTotalBytes: 1000 })
    ).rejects.toMatchObject({ kind: 'total-bytes' })
  })

  it('throws entries when the file-count cap is exceeded', async () => {
    const zipPath = path.join(tmp, 'many.zip')
    await makeZip(zipPath, { 'a.txt': 'a', 'b.txt': 'b', 'c.txt': 'c' })
    const out = path.join(tmp, 'om')
    fs.mkdirSync(out)
    await expect(
      extractZipToTemp(zipPath, out, { ...LIMITS, maxEntries: 2 })
    ).rejects.toMatchObject({ kind: 'entries' })
  })

  it('throws entries when a directory-only archive exceeds the file-count cap', async () => {
    // Regression test: the entry-count check used to sit AFTER the
    // directory-skip/symlink-skip `return zipfile.readEntry()` lines, so an
    // archive containing only directory records never incremented ctx.count
    // and bypassed maxEntries entirely. 3 empty-directory entries, cap of 2.
    const zipPath = path.join(tmp, 'dirs-only.zip')
    await makeZipRaw(zipPath, [], ['a/', 'b/', 'c/'])
    const out = path.join(tmp, 'odir')
    fs.mkdirSync(out)
    await expect(
      extractZipToTemp(zipPath, out, { ...LIMITS, maxEntries: 2 })
    ).rejects.toMatchObject({ kind: 'entries' })
  })

  it('throws ratio for a highly compressible entry above the ratio floor', async () => {
    const zipPath = path.join(tmp, 'bomb.zip')
    await makeZip(zipPath, { 'zeros.bin': Buffer.alloc(2 * 1024 * 1024, 0) }) // 2 MB zeros
    const out = path.join(tmp, 'or')
    fs.mkdirSync(out)
    await expect(extractZipToTemp(zipPath, out, { ...LIMITS, maxRatio: 5 })).rejects.toMatchObject({
      kind: 'ratio'
    })
  })
})
