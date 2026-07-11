import { describe, it, expect } from 'vitest'
import { diffLines } from '../lineDiff'

describe('diffLines', () => {
  it('marks unchanged, added and deleted lines', () => {
    const d = diffLines('a\nb\nc', 'a\nB\nc')
    expect(d).toEqual([
      { kind: 'same', text: 'a' },
      { kind: 'del', text: 'b' },
      { kind: 'add', text: 'B' },
      { kind: 'same', text: 'c' }
    ])
  })

  it('handles pure additions (new file)', () => {
    expect(diffLines('', 'x\ny')).toEqual([
      { kind: 'del', text: '' },
      { kind: 'add', text: 'x' },
      { kind: 'add', text: 'y' }
    ])
  })

  it('is line-ending agnostic (CRLF before vs LF after)', () => {
    const d = diffLines('a\r\nb\r\nc', 'a\nB\nc')
    expect(d).toEqual([
      { kind: 'same', text: 'a' },
      { kind: 'del', text: 'b' },
      { kind: 'add', text: 'B' },
      { kind: 'same', text: 'c' }
    ])
  })
})
