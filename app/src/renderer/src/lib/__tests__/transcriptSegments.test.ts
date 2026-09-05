import { describe, it, expect } from 'vitest'
import {
  segmentTranscript,
  lastAssistantIndexByTurn,
  forkDividerIndex
} from '../transcriptSegments'
import type { TranscriptItem } from '../agentStore'

const u = (turnId: number, text = 'q'): TranscriptItem => ({ kind: 'user', text, turnId })
const a = (turnId: number, text = 'r'): TranscriptItem => ({
  kind: 'assistant',
  text,
  streaming: false,
  turnId
})
const t = (turnId: number | null): TranscriptItem => ({
  kind: 'tool',
  toolCallId: `t${turnId}`,
  name: 'Edit',
  outputPreview: '',
  done: true,
  isError: false,
  turnId
})
const items = [u(1), a(1), u(2), t(2), a(2), u(3), a(3, 'r3a'), a(3, 'r3b')]

describe('segmentTranscript', () => {
  it('keeps everything live when nothing was rewound', () => {
    expect(segmentTranscript(items, [])).toEqual([
      { kind: 'live', items: items.map((item, index) => ({ item, index })) }
    ])
  })
  it('folds consecutive rewound turns of one anchor into one segment, in place', () => {
    const segs = segmentTranscript(items, [
      { turnId: 2, toTurnId: 1, at: 'T' },
      { turnId: 3, toTurnId: 1, at: 'T' }
    ])
    expect(segs.map((s) => s.kind)).toEqual(['live', 'rewound'])
    expect(segs[1]).toMatchObject({ toTurnId: 1, at: 'T', turnIds: [2, 3] })
    expect((segs[1] as { items: unknown[] }).items).toHaveLength(6)
  })
  it('splits rewound runs with different anchors', () => {
    const segs = segmentTranscript(items, [
      { turnId: 2, toTurnId: 1, at: 'T1' },
      { turnId: 3, toTurnId: 2, at: 'T2' }
    ])
    expect(segs.map((s) => s.kind)).toEqual(['live', 'rewound', 'rewound'])
  })
  it('folds a null-turnId item into the nearest preceding turn, even inside a rewound run', () => {
    const withNullTool = [u(1), a(1), u(2), t(null), a(2)]
    const segs = segmentTranscript(withNullTool, [{ turnId: 2, toTurnId: 1, at: 'T' }])
    expect(segs.map((s) => s.kind)).toEqual(['live', 'rewound'])
    expect((segs[1] as { items: unknown[] }).items).toHaveLength(3)
  })
  it('keeps a leading null-turnId item live — nothing precedes it to inherit from', () => {
    const leading = [t(null), u(1), a(1)]
    const segs = segmentTranscript(leading, [{ turnId: 1, toTurnId: 0, at: 'T' }])
    expect(segs.map((s) => s.kind)).toEqual(['live', 'rewound'])
    expect((segs[0] as { items: { index: number }[] }).items.map((x) => x.index)).toEqual([0])
  })
  it('is [] on an empty transcript', () => {
    expect(segmentTranscript([], [])).toEqual([])
  })
})
describe('lastAssistantIndexByTurn', () => {
  it('points at the final assistant item of each turn', () => {
    expect([...lastAssistantIndexByTurn(items)]).toEqual([
      [1, 1],
      [2, 4],
      [3, 7]
    ])
  })
})
describe('forkDividerIndex', () => {
  it('is the last item of the Nth distinct turn, or -1', () => {
    expect(forkDividerIndex(items, 2)).toBe(4)
    expect(forkDividerIndex(items, 0)).toBe(-1)
    expect(forkDividerIndex(items, 9)).toBe(7)
  })
  it('counts a trailing null-turnId tool item as part of the inherited turn it follows', () => {
    expect(forkDividerIndex([u(1), a(1), t(null), u(2)], 1)).toBe(2)
  })
  it('is -1 on an empty transcript', () => {
    expect(forkDividerIndex([], 1)).toBe(-1)
  })
})
