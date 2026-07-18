/** Incremental newline splitter — the single home for carry-buffer, CRLF, and
 *  final-line edge cases. Consumers own their IO; this owns line boundaries.
 *  Splits on raw \n bytes so multi-byte UTF-8 never decodes across a chunk. */

export const MAX_RENDER_LINE_CHARS = 10_000

export class LineSplitter {
  private carry = Buffer.alloc(0)
  private lineNo: number
  private byteStart: number

  constructor(startLine = 1, startByte = 0) {
    this.lineNo = startLine
    this.byteStart = startByte
  }

  /** Feed one chunk; cb per complete line. cb returning false stops the scan
   *  (push returns false and drops the carry — the consumer is done).
   *  CONTRACT: the Buffer handed to cb is a subarray VIEW into the pushed
   *  chunk (only the carry remainder is copied) — consume it synchronously
   *  inside the callback; never stash it across an await or reuse it after
   *  the caller's read buffer is overwritten. */
  push(
    chunk: Buffer,
    cb: (line: Buffer, lineNo: number, byteStart: number) => boolean | void
  ): boolean {
    const data = this.carry.length > 0 ? Buffer.concat([this.carry, chunk]) : chunk
    let start = 0
    let nl = data.indexOf(0x0a, start)
    while (nl !== -1) {
      const lineByte = this.byteStart
      this.byteStart += nl - start + 1
      const line = data.subarray(start, nl)
      const n = this.lineNo++
      start = nl + 1
      if (cb(line, n, lineByte) === false) {
        this.carry = Buffer.alloc(0)
        return false
      }
      nl = data.indexOf(0x0a, start)
    }
    // copy the remainder — callers may reuse their chunk buffer
    this.carry = Buffer.from(data.subarray(start))
    return true
  }

  /** Emit the final unterminated line, if any bytes remain. */
  flush(cb: (line: Buffer, lineNo: number, byteStart: number) => void): void {
    if (this.carry.length === 0) return
    const line = this.carry
    this.carry = Buffer.alloc(0)
    cb(line, this.lineNo++, this.byteStart)
    this.byteStart += line.length
  }
}

/** Decode a raw line for display: strip one trailing \r, cap render length.
 *  (Byte offsets in the index always include the \r — only display drops it.) */
export function decodeLine(buf: Buffer): string {
  const end = buf.length > 0 && buf[buf.length - 1] === 0x0d ? buf.length - 1 : buf.length
  const s = buf.toString('utf8', 0, end)
  return s.length > MAX_RENDER_LINE_CHARS ? s.slice(0, MAX_RENDER_LINE_CHARS) + ' …[truncated]' : s
}
