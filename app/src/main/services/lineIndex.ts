import crypto from 'node:crypto'
import fs from 'node:fs'
import path from 'node:path'
import { LineSplitter } from './lineScan'

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
