import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { Zip } from 'zip-lib'
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

// Build a zip at `zipPath` from {archivePath: contents} using zip-lib.
async function makeZip(zipPath: string, files: Record<string, string | Buffer>): Promise<void> {
  const zip = new Zip()
  const srcDir = fs.mkdtempSync(path.join(tmp, 'src-'))
  for (const [name, body] of Object.entries(files)) {
    const p = path.join(srcDir, path.basename(name))
    fs.writeFileSync(p, body)
    zip.addFile(p, name) // second arg = path inside the archive
  }
  await zip.archive(zipPath)
}

// Minimal raw-zip writer for adversarial entry names zip-lib won't produce.
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
  entries: Array<{ name: string; body: string }>
): Promise<void> {
  const zf = new ZipFile()
  const swaps = entries.map((e) => {
    const placeholder = toPlaceholderName(e.name)
    if (placeholder.length !== e.name.length) throw new Error('placeholder length mismatch')
    zf.addBuffer(Buffer.from(e.body), placeholder)
    return { placeholder, real: e.name }
  })
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

describe('extractZipToTemp', () => {
  it('stages every file entry, skipping directory entries', async () => {
    const zipPath = path.join(tmp, 'a.zip')
    await makeZip(zipPath, { 'logs/app.log': 'hello', 'notes.txt': 'world' })
    const out = path.join(tmp, 'out')
    fs.mkdirSync(out)
    const { entries } = await extractZipToTemp(zipPath, out, LIMITS)
    const byInner = Object.fromEntries(entries.map((e) => [e.innerPath, e]))
    expect(Object.keys(byInner).sort()).toEqual(['logs/app.log', 'notes.txt'])
    expect(fs.readFileSync(byInner['logs/app.log'].tempPath, 'utf8')).toBe('hello')
    expect(entries.every((e) => e.depth === 0)).toBe(true)
  })

  it('rejects an entry whose name escapes the output dir', async () => {
    // zip-lib refuses '../' names, so write a hand-crafted entry name via yazl.
    const evil = path.join(tmp, 'evil2.zip')
    await makeZipRaw(evil, [{ name: '../escape.txt', body: 'pwned' }])
    const out = path.join(tmp, 'o2')
    fs.mkdirSync(out)
    await expect(extractZipToTemp(evil, out, LIMITS)).rejects.toMatchObject({ kind: 'traversal' })
  })
})
