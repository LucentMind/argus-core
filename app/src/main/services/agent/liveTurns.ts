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
