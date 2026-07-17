import crypto from 'node:crypto'
import fs from 'node:fs'
import path from 'node:path'
import { LineSplitter, decodeLine } from './lineScan'

export const CHECKPOINT_LINES = 1000
export const CHECKPOINT_BYTES = 4 * 1024 * 1024
const BUILD_CHUNK_BYTES = 1024 * 1024
const MEM_CACHE_MAX = 16

export interface LineIndex {
  mtimeMs: number
  size: number
  totalLines: number
  /** [lineNo, byteOffsetOfLineStart], ascending; always starts [1, 0]. */
  checkpoints: Array<[number, number]>
}

// absPath → index, validated against live mtime+size on every ensureIndex hit
const memCache = new Map<string, LineIndex>()

export function __clearIndexCacheForTests(): void {
  memCache.clear()
}

export function sidecarPath(argusHome: string, absPath: string): string {
  const hash = crypto.createHash('sha1').update(path.resolve(absPath)).digest('hex')
  return path.join(argusHome, 'cache', 'lineidx', `${hash}.lineidx`)
}

/** Greatest checkpoint with line ≤ target (binary search). */
export function checkpointAtOrBelow(index: LineIndex, line: number): [number, number] {
  const cps = index.checkpoints
  let lo = 0
  let hi = cps.length - 1
  while (lo < hi) {
    const mid = (lo + hi + 1) >> 1
    if (cps[mid][0] <= line) lo = mid
    else hi = mid - 1
  }
  return cps[lo]
}

function loadSidecar(file: string, mtimeMs: number, size: number): LineIndex | null {
  try {
    const parsed = JSON.parse(fs.readFileSync(file, 'utf8')) as LineIndex & { version: number }
    if (parsed.version !== 1 || parsed.mtimeMs !== mtimeMs || parsed.size !== size) return null
    const { totalLines, checkpoints } = parsed
    return { mtimeMs, size, totalLines, checkpoints }
  } catch {
    return null
  }
}

async function buildIndex(
  absPath: string,
  mtimeMs: number,
  size: number,
  onProgress?: (fraction: number) => void
): Promise<LineIndex> {
  const checkpoints: Array<[number, number]> = [[1, 0]]
  let lastCpLine = 1
  let lastCpByte = 0
  let totalLines = 0
  const splitter = new LineSplitter()
  const record = (lineNo: number, byteStart: number): void => {
    totalLines = lineNo
    if (lineNo - lastCpLine >= CHECKPOINT_LINES || byteStart - lastCpByte >= CHECKPOINT_BYTES) {
      checkpoints.push([lineNo, byteStart])
      lastCpLine = lineNo
      lastCpByte = byteStart
    }
  }
  const fh = await fs.promises.open(absPath, 'r')
  try {
    const buf = Buffer.alloc(BUILD_CHUNK_BYTES)
    let offset = 0
    while (true) {
      const { bytesRead } = await fh.read(buf, 0, BUILD_CHUNK_BYTES, offset)
      if (bytesRead === 0) break
      offset += bytesRead
      splitter.push(buf.subarray(0, bytesRead), (_l, n, b) => record(n, b))
      onProgress?.(size > 0 ? Math.min(offset / size, 1) : 1)
    }
    splitter.flush((_l, n, b) => record(n, b))
  } finally {
    await fh.close()
  }
  onProgress?.(1)
  return { mtimeMs, size, totalLines, checkpoints }
}

/** Load-or-build the line index for absPath, keyed by live mtime+size.
 *  Persists a sidecar under <argusHome>/cache/lineidx/ — never next to the
 *  source file (repo worktrees must stay untouched). */
export async function ensureIndex(
  argusHome: string,
  absPath: string,
  onProgress?: (fraction: number) => void
): Promise<LineIndex> {
  const resolved = path.resolve(absPath)
  const stat = fs.statSync(resolved)
  const cached = memCache.get(resolved)
  if (cached && cached.mtimeMs === stat.mtimeMs && cached.size === stat.size) {
    // promote on hit so eviction tracks recency, not insertion order
    memCache.delete(resolved)
    memCache.set(resolved, cached)
    return cached
  }

  const side = sidecarPath(argusHome, resolved)
  let index = loadSidecar(side, stat.mtimeMs, stat.size)
  if (!index) {
    index = await buildIndex(resolved, stat.mtimeMs, stat.size, onProgress)
    fs.mkdirSync(path.dirname(side), { recursive: true })
    fs.writeFileSync(side, JSON.stringify({ version: 1, ...index }))
  }
  memCache.delete(resolved)
  memCache.set(resolved, index)
  if (memCache.size > MEM_CACHE_MAX) {
    const oldest = memCache.keys().next().value
    if (oldest !== undefined) memCache.delete(oldest)
  }
  return index
}

export const MAX_LINES_PER_READ = 2000

/** Read a clamped [from, to] line range via checkpoint seek. Synchronous —
 *  bounded work: one seek plus at most (checkpoint gap + range) lines. */
export function getLines(
  index: LineIndex,
  absPath: string,
  from: number,
  to: number
): { from: number; lines: string[] } {
  const start = Math.max(1, from)
  const end = Math.min(to, start + MAX_LINES_PER_READ - 1, index.totalLines)
  if (start > index.totalLines || end < start) return { from: start, lines: [] }

  const [cpLine, cpByte] = checkpointAtOrBelow(index, start)
  const lines: string[] = []
  const splitter = new LineSplitter(cpLine, cpByte)
  const onLine = (line: Buffer, n: number): boolean => {
    if (n >= start && n <= end) lines.push(decodeLine(line))
    return n < end
  }
  const fd = fs.openSync(absPath, 'r')
  try {
    const buf = Buffer.alloc(BUILD_CHUNK_BYTES)
    let offset = cpByte
    while (true) {
      const n = fs.readSync(fd, buf, 0, BUILD_CHUNK_BYTES, offset)
      if (n === 0) break
      offset += n
      if (!splitter.push(buf.subarray(0, n), onLine)) return { from: start, lines }
    }
    splitter.flush((line, n) => {
      if (n >= start && n <= end) lines.push(decodeLine(line))
    })
  } finally {
    fs.closeSync(fd)
  }
  return { from: start, lines }
}

export const DEFAULT_MAX_RESULTS = 100_000
const SEARCH_BATCH_LINES = 100_000 // yield cadence: lines scanned per batch

export interface SearchLinesOpts {
  regex?: boolean
  caseSensitive?: boolean
  fromLine?: number
  toLine?: number
  maxResults?: number
  signal?: AbortSignal
}

export interface SearchBatch {
  hits: number[]
  scannedTo: number
  done: boolean
  capped: boolean
}

/** Streaming scan over [fromLine, toLine], yielding batches of matching line
 *  numbers. Seeks via checkpoint — a second-half search never touches the
 *  first half. On cap, resume with fromLine = last scannedTo + 1. */
export async function* searchLines(
  index: LineIndex,
  absPath: string,
  query: string,
  opts: SearchLinesOpts = {}
): AsyncGenerator<SearchBatch> {
  const fromLine = Math.max(1, opts.fromLine ?? 1)
  const toLine = Math.min(opts.toLine ?? index.totalLines, index.totalLines)
  const maxResults = opts.maxResults ?? DEFAULT_MAX_RESULTS
  if (fromLine > toLine) {
    yield { hits: [], scannedTo: toLine, done: true, capped: false }
    return
  }
  const matcher: (s: string) => boolean = opts.regex
    ? (
        (re) => (s: string) =>
          re.test(s)
      )(new RegExp(query, opts.caseSensitive ? '' : 'i'))
    : ((q) =>
        opts.caseSensitive
          ? (s: string) => s.includes(q)
          : (s: string) => s.toLowerCase().includes(q))(
        opts.caseSensitive ? query : query.toLowerCase()
      )

  const [cpLine, cpByte] = checkpointAtOrBelow(index, fromLine)
  const splitter = new LineSplitter(cpLine, cpByte)
  let hits: number[] = []
  let found = 0
  let scannedTo = fromLine - 1
  let capped = false
  let sinceYield = 0

  const onLine = (line: Buffer, n: number): boolean => {
    if (n < fromLine) return true
    if (n > toLine) return false
    scannedTo = n
    sinceYield++
    if (matcher(line.toString('utf8'))) {
      hits.push(n)
      if (++found >= maxResults) {
        capped = true
        return false
      }
    }
    return true
  }

  const fh = await fs.promises.open(absPath, 'r')
  try {
    const buf = Buffer.alloc(BUILD_CHUNK_BYTES)
    let offset = cpByte
    let running = true
    while (running) {
      if (opts.signal?.aborted) {
        yield { hits, scannedTo, done: false, capped: false }
        return
      }
      const { bytesRead } = await fh.read(buf, 0, BUILD_CHUNK_BYTES, offset)
      if (bytesRead === 0) break
      offset += bytesRead
      running = splitter.push(buf.subarray(0, bytesRead), onLine)
      if (sinceYield >= SEARCH_BATCH_LINES && hits.length > 0) {
        sinceYield = 0
        const batch = hits
        hits = []
        yield { hits: batch, scannedTo, done: false, capped: false }
      }
    }
    if (running && !capped) {
      splitter.flush((line, n) => void onLine(line, n))
    }
  } finally {
    await fh.close()
  }
  yield { hits, scannedTo: capped ? scannedTo : Math.max(scannedTo, toLine), done: !capped, capped }
}
