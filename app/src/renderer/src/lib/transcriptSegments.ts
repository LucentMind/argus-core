import type { TranscriptItem } from './agentStore'
import type { RewoundTurn } from '../../../shared/branching'

export interface IndexedItem {
  item: TranscriptItem
  index: number
}

export type Segment =
  | { kind: 'live'; items: IndexedItem[] }
  | { kind: 'rewound'; toTurnId: number; at: string; turnIds: number[]; items: IndexedItem[] }

/**
 * Group the flat transcript into live stretches and collapsed "rewound" runs. Consecutive
 * items whose turn was rewound to the SAME anchor (`toTurnId`) fold into one segment, in
 * place — a rewind-of-a-rewind (different anchors back to back) starts a new segment rather
 * than merging, so RewoundTail always reports one coherent "rewound to X" story.
 */
export function segmentTranscript(items: TranscriptItem[], rewound: RewoundTurn[]): Segment[] {
  const byTurn = new Map(rewound.map((r) => [r.turnId, r]))
  const segs: Segment[] = []
  items.forEach((item, index) => {
    const r = item.turnId == null ? undefined : byTurn.get(item.turnId)
    const last = segs[segs.length - 1]
    if (!r) {
      if (last?.kind === 'live') last.items.push({ item, index })
      else segs.push({ kind: 'live', items: [{ item, index }] })
      return
    }
    if (last?.kind === 'rewound' && last.toTurnId === r.toTurnId) {
      last.items.push({ item, index })
      if (!last.turnIds.includes(r.turnId)) last.turnIds.push(r.turnId)
    } else {
      segs.push({
        kind: 'rewound',
        toTurnId: r.toTurnId,
        at: r.at,
        turnIds: [r.turnId],
        items: [{ item, index }]
      })
    }
  })
  return segs
}

/** Index of the LAST assistant item of each live turn — where TurnActions mounts. */
export function lastAssistantIndexByTurn(items: TranscriptItem[]): Map<number, number> {
  const m = new Map<number, number>()
  items.forEach((it, i) => {
    if (it.kind === 'assistant' && it.turnId != null) m.set(it.turnId, i)
  })
  return m
}

/** Index after which the fork divider renders (the last item of the Nth distinct turn), or -1. */
export function forkDividerIndex(items: TranscriptItem[], inheritedTurns: number): number {
  if (inheritedTurns <= 0) return -1
  const seen: number[] = []
  let lastIndex = -1
  items.forEach((it, i) => {
    if (it.turnId == null) return
    if (!seen.includes(it.turnId)) {
      if (seen.length === inheritedTurns) return
      seen.push(it.turnId)
    }
    if (seen.length <= inheritedTurns && it.turnId === seen[seen.length - 1]) lastIndex = i
  })
  return lastIndex
}
