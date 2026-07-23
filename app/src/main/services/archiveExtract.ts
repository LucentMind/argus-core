import fs from 'node:fs'
import path from 'node:path'
import { pipeline } from 'node:stream/promises'
import { Transform } from 'node:stream'
import yauzl from 'yauzl'

export interface ArchiveLimits {
  maxDepth: number // recursion levels; 0 = don't recurse into nested zips
  maxEntries: number // total file entries streamed across all levels
  maxTotalBytes: number // sum of decompressed bytes across all entries
  maxEntryBytes: number // per-entry decompressed cap
  maxRatio: number // per-entry bytesOut/bytesIn ceiling (checked above RATIO_FLOOR)
}
export interface ExtractedEntry {
  tempPath: string // absolute path to the staged temp file
  innerPath: string // archive-relative path, e.g. "logs/app.log"
  depth: number // 0 for top-level entries
}
export type ArchiveLimitKind =
  'depth' | 'entries' | 'total-bytes' | 'entry-bytes' | 'ratio' | 'traversal'
export class ArchiveLimitError extends Error {
  constructor(
    readonly kind: ArchiveLimitKind,
    message: string
  ) {
    super(message)
    this.name = 'ArchiveLimitError'
  }
}

const RATIO_FLOOR = 1_000_000 // only enforce ratio once an entry exceeds ~1 MB out

// Unix symlink bit lives in the top 16 bits of externalFileAttributes.
function isSymlink(entry: yauzl.Entry): boolean {
  const mode = (entry.externalFileAttributes >>> 16) & 0o170000
  return mode === 0o120000
}

interface Ctx {
  limits: ArchiveLimits
  tmpDir: string
  entries: ExtractedEntry[]
  count: number
  totalBytes: number
  seq: number
}

// Stream one zip entry to a fresh temp file, enforcing per-entry + total caps.
// Returns the temp path.
async function streamEntry(zipfile: yauzl.ZipFile, entry: yauzl.Entry, ctx: Ctx): Promise<string> {
  const dest = path.join(ctx.tmpDir, `e${ctx.seq++}`)
  let outBytes = 0
  const meter = new Transform({
    transform(chunk, _enc, cb) {
      outBytes += chunk.length
      if (outBytes > ctx.limits.maxEntryBytes)
        return cb(
          new ArchiveLimitError('entry-bytes', `entry ${entry.fileName} exceeds per-entry cap`)
        )
      if (ctx.totalBytes + outBytes > ctx.limits.maxTotalBytes)
        return cb(new ArchiveLimitError('total-bytes', 'archive exceeds total uncompressed cap'))
      cb(null, chunk)
    }
  })
  const readStream = await new Promise<NodeJS.ReadableStream>((res, rej) =>
    zipfile.openReadStream(entry, (err, s) => (err ? rej(err) : res(s)))
  )
  await pipeline(readStream, meter, fs.createWriteStream(dest))
  ctx.totalBytes += outBytes
  if (outBytes > RATIO_FLOOR && outBytes / Math.max(entry.compressedSize, 1) > ctx.limits.maxRatio)
    throw new ArchiveLimitError('ratio', `entry ${entry.fileName} compression ratio too high`)
  return dest
}

// Walk one zip file; recurse into nested zips until depth === maxDepth.
async function walk(zipPath: string, depth: number, prefix: string, ctx: Ctx): Promise<void> {
  // decodeStrings:true (yauzl's default, pinned explicitly) makes yauzl run
  // validateFileName on every entry, which rejects path-traversal / absolute /
  // drive-letter names before an 'entry' event fires; the 'error' handler below
  // translates that into ArchiveLimitError('traversal'). Do NOT set
  // decodeStrings:false without restoring an explicit pre-parse traversal check
  // — raw Buffer names skip validation.
  const zipfile = await new Promise<yauzl.ZipFile>((res, rej) =>
    yauzl.open(zipPath, { lazyEntries: true, decodeStrings: true }, (err, zf) =>
      err || !zf ? rej(err ?? new Error('open failed')) : res(zf)
    )
  )
  try {
    await new Promise<void>((resolve, reject) => {
      zipfile.readEntry()
      zipfile.on('entry', (entry: yauzl.Entry) => {
        void (async () => {
          if (/\/$/.test(entry.fileName)) return zipfile.readEntry() // directory
          if (isSymlink(entry)) return zipfile.readEntry()
          if (++ctx.count > ctx.limits.maxEntries)
            return reject(new ArchiveLimitError('entries', 'archive exceeds entry-count cap'))
          const inner = prefix ? `${prefix}/${entry.fileName}` : entry.fileName
          try {
            const staged = await streamEntry(zipfile, entry, ctx)
            const nested = entry.fileName.toLowerCase().endsWith('.zip')
            if (nested && depth < ctx.limits.maxDepth) {
              await walk(staged, depth + 1, inner, ctx)
              fs.rmSync(staged, { force: true }) // intermediate zip is not evidence
            } else {
              ctx.entries.push({ tempPath: staged, innerPath: inner, depth })
            }
            zipfile.readEntry()
          } catch (err) {
            reject(err)
          }
        })()
      })
      zipfile.on('end', resolve)
      zipfile.on('error', (err: Error) => {
        // Translate yauzl's own validateFileName errors (see the comment on the
        // yauzl.open call above) into our ArchiveLimitError('traversal').
        if (/^(invalid relative path|absolute path):/.test(err.message))
          return reject(new ArchiveLimitError('traversal', err.message))
        reject(err)
      })
    })
  } finally {
    zipfile.close()
  }
}

export async function extractZipToTemp(
  zipPath: string,
  tmpDir: string,
  limits: ArchiveLimits
): Promise<{ entries: ExtractedEntry[] }> {
  const ctx: Ctx = { limits, tmpDir, entries: [], count: 0, totalBytes: 0, seq: 0 }
  await walk(zipPath, 0, '', ctx)
  return { entries: ctx.entries }
}
