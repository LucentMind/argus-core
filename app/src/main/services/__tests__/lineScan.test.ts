import { describe, it, expect } from 'vitest'
import { LineSplitter, decodeLine, MAX_RENDER_LINE_CHARS } from '../lineScan'

function collect(chunks: Buffer[]): Array<{ line: string; n: number; byte: number }> {
  const out: Array<{ line: string; n: number; byte: number }> = []
  const s = new LineSplitter()
  for (const c of chunks) s.push(c, (l, n, b) => void out.push({ line: l.toString(), n, byte: b }))
  s.flush((l, n, b) => out.push({ line: l.toString(), n, byte: b }))
  return out
}

describe('LineSplitter', () => {
  it('splits lines with 1-based numbers and exact byte offsets', () => {
    expect(collect([Buffer.from('ab\ncde\nf\n')])).toEqual([
      { line: 'ab', n: 1, byte: 0 },
      { line: 'cde', n: 2, byte: 3 },
      { line: 'f', n: 3, byte: 7 }
    ])
  })

  it('carries partial lines across pushes (multi-byte safe)', () => {
    // '€' = 3 bytes e2 82 ac, split mid-character
    const euro = Buffer.from('a€b\nc\n')
    expect(collect([euro.subarray(0, 2), euro.subarray(2)])).toEqual([
      { line: 'a€b', n: 1, byte: 0 },
      { line: 'c', n: 2, byte: 6 }
    ])
  })

  it('flush emits a final unterminated line; empty input emits nothing', () => {
    expect(collect([Buffer.from('x\ntail')])).toEqual([
      { line: 'x', n: 1, byte: 0 },
      { line: 'tail', n: 2, byte: 2 }
    ])
    expect(collect([Buffer.from('')])).toEqual([])
  })

  it('honors startLine/startByte and early exit (cb → false)', () => {
    const s = new LineSplitter(500, 12_345)
    const seen: number[] = []
    const cont = s.push(Buffer.from('a\nb\nc\n'), (_l, n) => {
      seen.push(n)
      return n < 501 // stop after line 501
    })
    expect(cont).toBe(false)
    expect(seen).toEqual([500, 501])
  })
})

describe('decodeLine', () => {
  it('strips one trailing \\r and caps render length', () => {
    expect(decodeLine(Buffer.from('crlf line\r'))).toBe('crlf line')
    const long = decodeLine(Buffer.from('x'.repeat(MAX_RENDER_LINE_CHARS + 5)))
    expect(long.length).toBe(MAX_RENDER_LINE_CHARS + ' …[truncated]'.length)
    expect(long.endsWith(' …[truncated]')).toBe(true)
  })
})
