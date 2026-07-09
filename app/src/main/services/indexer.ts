import fs from 'node:fs'
import type { DatabaseSync } from 'node:sqlite'

const READ_CHUNK_BYTES = 1024 * 1024

// Indexes a file straight off disk in fixed-size byte chunks, splitting on raw
// \n bytes so multi-byte UTF-8 characters are never decoded across a chunk
// boundary. Never materializes the whole file as one JS string — required
// for files over V8's ~512MB string-length ceiling, and keeps memory bounded
// for any file size.
export function indexEvidenceFile(
  db: DatabaseSync,
  evidenceId: number,
  absPath: string,
  chunkLines = 400
): number {
  const ins = db.prepare(
    `INSERT INTO evidence_fts (content, evidence_id, chunk_index, start_line, end_line)
     VALUES (?, ?, ?, ?, ?)`
  )
  const fd = fs.openSync(absPath, 'r')
  try {
    const buf = Buffer.alloc(READ_CHUNK_BYTES)
    let carry = Buffer.alloc(0)
    let lineNo = 0
    let chunkIndex = 0
    let chunkStart = 1
    let pending: string[] = []
    let offset = 0

    const flush = (): void => {
      if (pending.length === 0) return
      ins.run(
        pending.join('\n'),
        evidenceId,
        chunkIndex,
        chunkStart,
        chunkStart + pending.length - 1
      )
      chunkIndex++
      chunkStart = lineNo + 1
      pending = []
    }

    while (true) {
      const n = fs.readSync(fd, buf, 0, READ_CHUNK_BYTES, offset)
      if (n === 0) break
      offset += n
      const data = Buffer.concat([carry, buf.subarray(0, n)])
      let start = 0
      let nl = data.indexOf(0x0a, start)
      while (nl !== -1) {
        lineNo++
        pending.push(data.subarray(start, nl).toString('utf8'))
        if (pending.length >= chunkLines) flush()
        start = nl + 1
        nl = data.indexOf(0x0a, start)
      }
      carry = data.subarray(start)
    }
    if (carry.length > 0) {
      lineNo++
      pending.push(carry.toString('utf8'))
    }
    flush()
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
  let chunkIndex = 0
  for (let start = 0; start < lines.length; start += chunkLines) {
    const chunk = lines.slice(start, start + chunkLines)
    ins.run(chunk.join('\n'), evidenceId, chunkIndex, start + 1, start + chunk.length)
    chunkIndex++
  }
  return chunkIndex
}

export function deleteEvidenceIndex(db: DatabaseSync, evidenceId: number): void {
  db.prepare(`DELETE FROM evidence_fts WHERE evidence_id = ?`).run(evidenceId)
}
