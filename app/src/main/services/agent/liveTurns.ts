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

/**
 * The join + predicate every model-facing `messages_fts` reader needs, in one place.
 *
 * Three readers feed the model from that index — `distill/input.ts`'s user messages,
 * `distill/world.ts`'s transcripts and `rca/input.ts`'s drafter input — and each carried its
 * own copy of the same LEFT JOIN and the same `IS NULL OR != 'rewound'` predicate, with the
 * status value interpolated into the SQL text. Three copies of one rule is three chances for
 * one of them to stop matching, and nothing would fail loudly: a reader that silently stops
 * filtering just starts feeding rewound turns back into the model, which is precisely what spec
 * §7.1 exists to prevent (and what per-file review cannot see — memory
 * `argus-two-representations-defect-class`).
 *
 * `alias` is the `messages_fts` alias in the caller's query. The status is BOUND, not
 * interpolated — bind it as the LAST parameter of the statement, which is where `where` sits in
 * all three callers. The turns alias is `lt`, chosen not to collide with anything the callers
 * already use.
 */
export function liveTurnJoinSql(alias: string): { join: string; where: string; param: string } {
  return {
    join: `LEFT JOIN turns lt ON lt.id = ${alias}.turn_id`,
    // `IS NULL` keeps a row no local turn matches, for the same reason `rewoundTurnIds` does:
    // an imported case's index rows carry no turn id at all, and a restored one's could name a
    // row that was rebuilt. Unmatched is not evidence of a rewind.
    where: `(lt.status IS NULL OR lt.status != ?)`,
    param: TURN_STATUS_REWOUND
  }
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
