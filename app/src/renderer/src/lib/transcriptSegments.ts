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
 * Forward-fill each item's turn: an item with `turnId == null` (old mirrored events, pre-branch,
 * carry no turnId on tool items) belongs to the turn of the nearest PRECEDING item that has one.
 * A null-turnId item before any turn has been seen yet has no turn to inherit and stays `null`
 * (session-level items before any turn stay live). Both `segmentTranscript` and
 * `forkDividerIndex` key off this resolved id rather than the item's own `turnId`, so a
 * null-turnId item folds into whatever turn — live or rewound — its predecessor belongs to,
 * instead of splitting a run or drifting the fork boundary.
 */
function effectiveTurnIds(items: TranscriptItem[]): (number | null)[] {
  const out: (number | null)[] = []
  let last: number | null = null
  for (const item of items) {
    if (item.turnId != null) last = item.turnId
    out.push(item.turnId ?? last)
  }
  return out
}

/**
 * Group the flat transcript into live stretches and collapsed "rewound" runs. Consecutive
 * items whose turn was rewound to the SAME anchor (`toTurnId`) fold into one segment, in
 * place — a rewind-of-a-rewind (different anchors back to back) starts a new segment rather
 * than merging, so RewoundTail always reports one coherent "rewound to X" story.
 */
export function segmentTranscript(items: TranscriptItem[], rewound: RewoundTurn[]): Segment[] {
  const byTurn = new Map(rewound.map((r) => [r.turnId, r]))
  const effIds = effectiveTurnIds(items)
  const segs: Segment[] = []
  items.forEach((item, index) => {
    const effTurnId = effIds[index]
    const r = effTurnId == null ? undefined : byTurn.get(effTurnId)
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

/** Index after which the fork divider renders (the last item of the Nth distinct turn), or -1.
 *  Distinct turns are counted by resolved turn (see `effectiveTurnIds`), so a trailing
 *  null-turnId tool item of the Nth inherited turn still counts as that turn's last item. */
export function forkDividerIndex(items: TranscriptItem[], inheritedTurns: number): number {
  if (inheritedTurns <= 0) return -1
  const effIds = effectiveTurnIds(items)
  const seen: number[] = []
  let lastIndex = -1
  items.forEach((_it, i) => {
    const effTurnId = effIds[i]
    if (effTurnId == null) return
    if (!seen.includes(effTurnId)) {
      if (seen.length === inheritedTurns) return
      seen.push(effTurnId)
    }
    if (seen.length <= inheritedTurns && effTurnId === seen[seen.length - 1]) lastIndex = i
  })
  return lastIndex
}
