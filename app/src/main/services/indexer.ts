import fs from 'node:fs'
import path from 'node:path'
import type { DatabaseSync } from 'node:sqlite'
import { LineSplitter } from './lineScan'
import { sidecarPath, CHECKPOINT_LINES, CHECKPOINT_BYTES } from './lineIndex'
import { MAX_READ_BYTES } from './search'
import { deleteEvidenceFtsForEvidence } from './ftsIndex'

const READ_CHUNK_BYTES = 1024 * 1024

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
  const ins = db.prepare(
    `INSERT INTO evidence_fts (content, evidence_id, chunk_index, start_line, end_line)
     VALUES (?, ?, ?, ?, ?)`
  )
  // side table for O(deleted-rows) FTS deletes — see ftsIndex.ts
  const insMap = db.prepare(`INSERT INTO evidence_fts_map (fts_rowid, evidence_id) VALUES (?, ?)`)
  const stat = fs.statSync(absPath)
  const wantSidecar = argusHome !== undefined && stat.size > MAX_READ_BYTES
  const checkpoints: Array<[number, number]> = [[1, 0]]
  let lastCpLine = 1
  let lastCpByte = 0

  const fd = fs.openSync(absPath, 'r')
  try {
    const buf = Buffer.alloc(READ_CHUNK_BYTES)
    let lineNo = 0
    let chunkIndex = 0
    let chunkStart = 1
    let pending: string[] = []
    let offset = 0
    const splitter = new LineSplitter()

    const flush = (): void => {
      if (pending.length === 0) return
      const rowid = ins.run(
        pending.join('\n'),
        evidenceId,
        chunkIndex,
        chunkStart,
        chunkStart + pending.length - 1
      ).lastInsertRowid
      insMap.run(rowid, evidenceId)
      chunkIndex++
      chunkStart = lineNo + 1
      pending = []
    }
    const onLine = (line: Buffer, n: number, byteStart: number): void => {
      lineNo = n
      pending.push(line.toString('utf8'))
      if (pending.length >= chunkLines) flush()
      if (
        wantSidecar &&
        (n - lastCpLine >= CHECKPOINT_LINES || byteStart - lastCpByte >= CHECKPOINT_BYTES)
      ) {
        checkpoints.push([n, byteStart])
        lastCpLine = n
        lastCpByte = byteStart
      }
    }

    while (true) {
      const n = fs.readSync(fd, buf, 0, READ_CHUNK_BYTES, offset)
      if (n === 0) break
      offset += n
      splitter.push(buf.subarray(0, n), onLine)
    }
    splitter.flush(onLine)
    flush()

    if (wantSidecar) {
      const side = sidecarPath(argusHome as string, absPath)
      fs.mkdirSync(path.dirname(side), { recursive: true })
      fs.writeFileSync(
        side,
        JSON.stringify({
          version: 1,
          mtimeMs: stat.mtimeMs,
          size: stat.size,
          totalLines: lineNo,
          checkpoints
        })
      )
    }
    return chunkIndex
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
  const ins = db.prepare(
    `INSERT INTO evidence_fts (content, evidence_id, chunk_index, start_line, end_line)
     VALUES (?, ?, ?, ?, ?)`
  )
  const insMap = db.prepare(`INSERT INTO evidence_fts_map (fts_rowid, evidence_id) VALUES (?, ?)`)
  let chunkIndex = 0
  for (let start = 0; start < lines.length; start += chunkLines) {
    const chunk = lines.slice(start, start + chunkLines)
    const rowid = ins.run(
      chunk.join('\n'),
      evidenceId,
      chunkIndex,
      start + 1,
      start + chunk.length
    ).lastInsertRowid
    insMap.run(rowid, evidenceId)
    chunkIndex++
  }
  return chunkIndex
}

export function deleteEvidenceIndex(db: DatabaseSync, evidenceId: number): void {
  deleteEvidenceFtsForEvidence(db, evidenceId)
}
