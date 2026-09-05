import type { DatabaseSync } from 'node:sqlite'
import { TURN_STATUS_REWOUND, type RewoundTurn } from '../../../shared/branching'

/**
 * The ONLY source of "which turns of this session may the model see". Every model-facing
 * reader (history digest, read_session_transcript, the distill input builders) takes this
 * set; none of them queries `turns.status` on its own (spec §7).
 */
export function liveTurnIds(db: DatabaseSync, sessionId: number): Set<number> {
  const rows = db
    .prepare(`SELECT id FROM turns WHERE session_id = ? AND status != ?`)
    .all(sessionId, TURN_STATUS_REWOUND) as { id: number }[]
  return new Set(rows.map((r) => r.id))
}

/**
 * The turn ids a rewind POSITIVELY discarded. The complement of `liveTurnIds` only over ids
 * that actually have a row here — and that difference is the whole point.
 *
 * The mirror readers (`filterLiveEvents`) classify events by the `turnId` on a JSONL line, and
 * plenty of legitimate lines name an id no local row will ever match: `importCase` rewrites
 * `caseId`/`caseSlug`/`sessionId` on every imported line but leaves `turnId` at the EXPORTING
 * machine's autoincrement and creates no `turns` rows at all, and an archive restored from a
 * bundle with no `rows.json` sidecar is in the same state. Asking "is this id live?" answers
 * "no" for all of them and throws the entire history away; asking "was this id rewound?"
 * answers "no" too — and keeps it. An unmatched id is not ours to judge: keep it.
 *
 * This is the same semantics the three SQL readers already have (`LEFT JOIN turns … t.status
 * IS NULL OR t.status != 'rewound'` keeps unmatched rows), stated once for the mirror side.
 */
export function rewoundTurnIds(db: DatabaseSync, sessionId: number): Set<number> {
  const rows = db
    .prepare(`SELECT id FROM turns WHERE session_id = ? AND status = ?`)
    .all(sessionId, TURN_STATUS_REWOUND) as { id: number }[]
  return new Set(rows.map((r) => r.id))
}

export function rewoundTurnsOf(db: DatabaseSync, sessionId: number): RewoundTurn[] {
  const rows = db
    .prepare(
      `SELECT id, rewound_to_turn_id, rewound_at FROM turns
        WHERE session_id = ? AND status = ? ORDER BY id`
    )
    .all(sessionId, TURN_STATUS_REWOUND) as {
    id: number
    rewound_to_turn_id: number
    rewound_at: string
  }[]
  return rows.map((r) => ({ turnId: r.id, toTurnId: r.rewound_to_turn_id, at: r.rewound_at }))
}
