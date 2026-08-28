import fs from 'node:fs'
import path from 'node:path'
import type { DatabaseSync } from 'node:sqlite'
import { LineSplitter } from './lineScan'
import { sidecarPath, CHECKPOINT_LINES, CHECKPOINT_BYTES } from './lineIndex'
import { MAX_READ_BYTES } from './search'
import {
  deleteEvidenceFtsForEvidence,
  deleteEvidenceFtsThorough,
  withFtsSavepoint
} from './ftsIndex'

const READ_CHUNK_BYTES = 1024 * 1024

/** Accumulates lines into fixed-size chunks and writes each to the contentless
 *  evidence_index plus the evidence_index_map side table, which carries the
 *  evidence_id/chunk_index/start_line/end_line locators a contentless table cannot
 *  return (see db.ts and ftsIndex.ts — the map is also what makes per-evidence
 *  deletes O(deleted rows) instead of a full-table scan).
 *  Shared by the sync and async indexers so the two cannot drift. */
export class FtsChunkWriter {
  private readonly db: DatabaseSync
  private readonly ins
  private readonly insMap
  private pending: string[] = []
  private chunkIndex = 0
  private chunkStart = 1
  private lastLineNo = 0

  constructor(
    db: DatabaseSync,
    private readonly evidenceId: number,
    private readonly chunkLines: number
  ) {
    this.db = db
    this.ins = db.prepare(`INSERT INTO evidence_index (content) VALUES (?)`)
    this.insMap = db.prepare(
      `INSERT INTO evidence_index_map (fts_rowid, evidence_id, chunk_index, start_line, end_line)
       VALUES (?, ?, ?, ?, ?)`
    )
  }

  add(line: string, lineNo: number): void {
    this.lastLineNo = lineNo
    this.pending.push(line)
    if (this.pending.length >= this.chunkLines) this.flush()
  }

  /**
   * One chunk = one atomic write of the FTS row AND its map row (see
   * withFtsSavepoint). An interruption between the two used to leave an FTS row the
   * map-driven delete could never see: it survived crash recovery, duplicated its
   * chunk_index on the re-index, and could never be reclaimed.
   *
   * Per-flush, deliberately. Batching many chunks into one transaction would be
   * cheaper in fsyncs but would hold a write lock open across the async indexer's
   * awaited reads, blocking every other main-process DB write for the whole file.
   * flush() is synchronous and called from a synchronous line callback, so the
   * savepoint opens and closes without ever spanning an await. Measured cost of the
   * savepoint on a 199MB / 3945-chunk file: none (it replaces two implicit
   * transactions with one).
   */
  flush(): void {
    if (this.pending.length === 0) return
    withFtsSavepoint(this.db, () => {
      const rowid = this.ins.run(this.pending.join('\n')).lastInsertRowid
      this.insMap.run(
        rowid,
        this.evidenceId,
        this.chunkIndex,
        this.chunkStart,
        this.chunkStart + this.pending.length - 1
      )
    })
    this.chunkIndex++
    this.chunkStart = this.lastLineNo + 1
    this.pending = []
  }

  get chunkCount(): number {
    return this.chunkIndex
  }
}

/** Collects line-index checkpoints for the large-file viewer's sidecar. Disabled
 *  instances still expose the mandatory origin checkpoint so callers need no branch. */
export class CheckpointRecorder {
  private readonly points: Array<[number, number]> = [[1, 0]]
  private lastLine = 1
  private lastByte = 0

  constructor(private readonly enabled: boolean) {}

  record(lineNo: number, byteStart: number): void {
    if (!this.enabled) return
    if (
      lineNo - this.lastLine >= CHECKPOINT_LINES ||
      byteStart - this.lastByte >= CHECKPOINT_BYTES
    ) {
      this.points.push([lineNo, byteStart])
      this.lastLine = lineNo
      this.lastByte = byteStart
    }
  }

  get checkpoints(): Array<[number, number]> {
    return this.points
  }
}

/** Write the piggybacked line-index sidecar produced during an FTS pass. */
function writePiggybackSidecar(
  argusHome: string,
  absPath: string,
  stat: fs.Stats,
  totalLines: number,
  checkpoints: Array<[number, number]>
): void {
  const side = sidecarPath(argusHome, absPath)
  fs.mkdirSync(path.dirname(side), { recursive: true })
  fs.writeFileSync(
    side,
    JSON.stringify({
      version: 1,
      mtimeMs: stat.mtimeMs,
      size: stat.size,
      totalLines,
      checkpoints
    })
  )
}

// Indexes a file straight off disk in fixed-size byte chunks, splitting on raw
// \n bytes so multi-byte UTF-8 characters are never decoded across a chunk
// boundary. Never materializes the whole file as one JS string — required
// for files over V8's ~512MB string-length ceiling, and keeps memory bounded
// for any file size.
//
// When argusHome is given and the file exceeds MAX_READ_BYTES, this also
// records line-index checkpoints in the same pass and writes them as a
// sidecar (see lineIndex.ts) — one scan of the file produces both the FTS
// chunks and the piggybacked line index, so the large-file viewer never has
// to re-scan a file it just ingested.
export function indexEvidenceFile(
  db: DatabaseSync,
  evidenceId: number,
  absPath: string,
  chunkLines = 400,
  argusHome?: string
): number {
  const stat = fs.statSync(absPath)
  const wantSidecar = argusHome !== undefined && stat.size > MAX_READ_BYTES
  const writer = new FtsChunkWriter(db, evidenceId, chunkLines)
  const cps = new CheckpointRecorder(wantSidecar)
  let lineNo = 0

  const onLine = (line: Buffer, n: number, byteStart: number): void => {
    lineNo = n
    writer.add(line.toString('utf8'), n)
    cps.record(n, byteStart)
  }

  const fd = fs.openSync(absPath, 'r')
  try {
    const buf = Buffer.alloc(READ_CHUNK_BYTES)
    const splitter = new LineSplitter()
    let offset = 0
    while (true) {
      const n = fs.readSync(fd, buf, 0, READ_CHUNK_BYTES, offset)
      if (n === 0) break
      offset += n
      splitter.push(buf.subarray(0, n), onLine)
    }
    splitter.flush(onLine)
    writer.flush()
    if (wantSidecar) {
      writePiggybackSidecar(argusHome as string, absPath, stat, lineNo, cps.checkpoints)
    }
    return writer.chunkCount
  } finally {
    fs.closeSync(fd)
  }
}

export function indexEvidenceText(
  db: DatabaseSync,
  evidenceId: number,
  text: string,
  chunkLines = 400
): number {
  const lines = text.split('\n')
  // trailing newline produces a final empty element — drop it
  if (lines.length > 0 && lines[lines.length - 1] === '') lines.pop()
  // Delegates to FtsChunkWriter rather than repeating its insert pair, savepoint and
  // chunk arithmetic: a second copy would have to be kept in step with it by hand,
  // and the compiler cannot see when it drifts.
  const writer = new FtsChunkWriter(db, evidenceId, chunkLines)
  lines.forEach((line, i) => writer.add(line, i + 1))
  writer.flush()
  return writer.chunkCount
}

export function deleteEvidenceIndex(db: DatabaseSync, evidenceId: number): void {
  deleteEvidenceFtsForEvidence(db, evidenceId)
}

/**
 * Crash-recovery variant of deleteEvidenceIndex. Boot-only — see
 * deleteEvidenceFtsThorough for why the deliberately slow, map-independent delete is
 * the correct one on that one path and must not be used anywhere else.
 */
export function deleteEvidenceIndexThorough(db: DatabaseSync, evidenceId: number): void {
  deleteEvidenceFtsThorough(db, evidenceId)
}

/** Thrown by indexEvidenceFileAsync when its shouldAbort predicate goes true.
 *  Distinct from a real failure: the caller drops the job instead of marking
 *  the evidence as errored. */
export class IndexAbortedError extends Error {
  constructor(evidenceId: number) {
    super(`Indexing aborted for evidence ${evidenceId}`)
    this.name = 'IndexAbortedError'
  }
}

export interface IndexFileOptions {
  onProgress?: (bytesDone: number, bytesTotal: number) => void
  shouldAbort?: () => boolean
}

/**
 * Async twin of indexEvidenceFile, shaped like lineIndex.buildIndex: one awaited
 * FileHandle.read per 1MB chunk, so the main-process event loop breathes between
 * chunks and IPC keeps flowing while a multi-hundred-megabyte trace is indexed.
 *
 * The FTS inserts themselves stay synchronous — each covers one 400-line chunk and
 * completes in well under a millisecond. The freeze this exists to remove came from
 * one uninterrupted multi-second read loop, not from the cost of an insert.
 */
export async function indexEvidenceFileAsync(
  db: DatabaseSync,
  evidenceId: number,
  absPath: string,
  chunkLines = 400,
  argusHome?: string,
  opts: IndexFileOptions = {}
): Promise<number> {
  const stat = fs.statSync(absPath)
  const wantSidecar = argusHome !== undefined && stat.size > MAX_READ_BYTES
  const writer = new FtsChunkWriter(db, evidenceId, chunkLines)
  const cps = new CheckpointRecorder(wantSidecar)
  let lineNo = 0

  const onLine = (line: Buffer, n: number, byteStart: number): void => {
    lineNo = n
    writer.add(line.toString('utf8'), n)
    cps.record(n, byteStart)
  }

  const fh = await fs.promises.open(absPath, 'r')
  try {
    const buf = Buffer.alloc(READ_CHUNK_BYTES)
    const splitter = new LineSplitter()
    let offset = 0
    while (true) {
      if (opts.shouldAbort?.()) throw new IndexAbortedError(evidenceId)
      const { bytesRead } = await fh.read(buf, 0, READ_CHUNK_BYTES, offset)
      if (bytesRead === 0) break
      offset += bytesRead
      splitter.push(buf.subarray(0, bytesRead), onLine)
      opts.onProgress?.(offset, stat.size)
    }
    splitter.flush(onLine)
    writer.flush()
    if (wantSidecar) {
      writePiggybackSidecar(argusHome as string, absPath, stat, lineNo, cps.checkpoints)
    }
    opts.onProgress?.(stat.size, stat.size)
    return writer.chunkCount
  } finally {
    await fh.close()
  }
}
