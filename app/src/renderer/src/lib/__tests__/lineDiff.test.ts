import { describe, it, expect } from 'vitest'
import { diffLines, pairRows } from '../lineDiff'

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

  it('keeps a real diff for a large, mostly-identical file (no degenerate full replace)', () => {
    // A ~670-line reference edited by inserting a section is a real skill/reference size:
    // 671 * 662 exceeds the old 400k LCS guard, which wrongly collapsed it to full replace.
    const base = Array.from({ length: 670 }, (_, i) => `line ${i}`)
    const before = base.join('\n')
    const after = [...base.slice(0, 300), 'INSERTED SECTION', ...base.slice(300)].join('\n')
    const d = diffLines(before, after)
    const same = d.filter((l) => l.kind === 'same').length
    expect(same).toBeGreaterThan(600) // the shared lines are matched, not re-added
    expect(d).toContainEqual({ kind: 'add', text: 'INSERTED SECTION' })
  })
})

describe('pairRows', () => {
  it('aligns unchanged lines and pairs del/add runs side by side', () => {
    const rows = pairRows(diffLines('a\nb\nc', 'a\nx\nc'))
    expect(rows).toEqual([
      { left: { no: 1, text: 'a', kind: 'same' }, right: { no: 1, text: 'a', kind: 'same' } },
      { left: { no: 2, text: 'b', kind: 'del' }, right: { no: 2, text: 'x', kind: 'add' } },
      { left: { no: 3, text: 'c', kind: 'same' }, right: { no: 3, text: 'c', kind: 'same' } }
    ])
  })

  it('pads uneven runs with null cells', () => {
    const rows = pairRows(diffLines('a', 'a\nnew1\nnew2'))
    expect(rows[1]).toEqual({ left: null, right: { no: 2, text: 'new1', kind: 'add' } })
    expect(rows[2]).toEqual({ left: null, right: { no: 3, text: 'new2', kind: 'add' } })
  })

  it('flushes a trailing del/add run', () => {
    const rows = pairRows(diffLines('a\nb', 'a'))
    expect(rows[1]).toEqual({ left: { no: 2, text: 'b', kind: 'del' }, right: null })
  })

  it('honors start-line offsets (for unified-diff hunks)', () => {
    const rows = pairRows([{ kind: 'same', text: 'ctx' }], 10, 20)
    expect(rows).toEqual([
      { left: { no: 10, text: 'ctx', kind: 'same' }, right: { no: 20, text: 'ctx', kind: 'same' } }
    ])
  })
})
