import type { DatabaseSync } from 'node:sqlite'

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
