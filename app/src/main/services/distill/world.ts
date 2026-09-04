import type { DatabaseSync } from 'node:sqlite'
import type { DistillWorld, WorldMessage, WorldSession } from '../../../shared/distill'
import { TURN_STATUS_REWOUND } from '../../../shared/branching'

export const WORLD_MSG_CLAMP = 8_000
const CLAMP_HEAD = 6_000
export const WORLD_SESSION_MAX_MSGS = 1_000
export const WORLD_SESSION_MAX_BYTES = 1_000_000
export const WORLD_TOTAL_MAX_BYTES = 8_000_000

export interface WorldClamps {
  msgClamp: number
  sessionMaxMsgs: number
  sessionMaxBytes: number
  totalMaxBytes: number
}
const DEFAULTS: WorldClamps = {
  msgClamp: WORLD_MSG_CLAMP,
  sessionMaxMsgs: WORLD_SESSION_MAX_MSGS,
  sessionMaxBytes: WORLD_SESSION_MAX_BYTES,
  totalMaxBytes: WORLD_TOTAL_MAX_BYTES
}

export function clampText(s: string, cap: number): { text: string; truncated: boolean } {
  if (s.length <= cap) return { text: s, truncated: false }
  const head = Math.floor(cap * (CLAMP_HEAD / WORLD_MSG_CLAMP))
  const tail = cap - head
  return {
    text: s.slice(0, head) + `[… ${s.length - cap} chars omitted]` + s.slice(s.length - tail),
    truncated: true
  }
}

/** Byte budgets are enforced in true UTF-8 bytes, not UTF-16 code units --
 *  `.length` undercounts any multi-byte (e.g. CJK) content. */
function byteLen(s: string): number {
  return Buffer.byteLength(s, 'utf8')
}

/** Deliberately NOT listSessions(): that helper CREATES a session when none exist —
 *  a snapshot must never mutate the case it snapshots. */
export function buildWorld(
  db: DatabaseSync,
  slug: string,
  clamps: WorldClamps = DEFAULTS
): DistillWorld {
  const c = db.prepare(`SELECT id FROM cases WHERE slug = ?`).get(slug) as
    { id: number } | undefined
  if (!c) return { sessions: [] }
  const sessionRows = db
    .prepare(`SELECT id, title FROM sessions WHERE case_id = ? ORDER BY id ASC`)
    .all(c.id) as { id: number; title: string }[]
  const sessions: WorldSession[] = sessionRows.map((s) => {
    const rows = db
      .prepare(
        `SELECT m.role, m.content FROM messages_fts m
           LEFT JOIN turns t ON t.id = m.turn_id
          WHERE m.case_id = ? AND m.session_id = ?
            AND (t.status IS NULL OR t.status != '${TURN_STATUS_REWOUND}')
          ORDER BY m.rowid ASC`
      )
      .all(c.id, s.id) as { role: string; content: string }[]
    let kept = rows
    let dropped = 0
    if (kept.length > clamps.sessionMaxMsgs) {
      dropped = kept.length - clamps.sessionMaxMsgs
      kept = kept.slice(-clamps.sessionMaxMsgs) // late messages carry conclusions
    }
    // clamp each message's text, then apply the byte budget from the END backwards:
    // keep the suffix that fits (late messages carry conclusions), drop the earliest
    // messages in the window first. Chronological order is preserved in the output.
    const clamped = kept.map((r) => {
      const { text, truncated } = clampText(r.content, clamps.msgClamp)
      return { role: r.role, content: text, truncated, bytes: byteLen(text) }
    })
    let bytes = 0
    let keepFrom = clamped.length
    for (let i = clamped.length - 1; i >= 0; i--) {
      if (bytes + clamped[i].bytes > clamps.sessionMaxBytes) break
      bytes += clamped[i].bytes
      keepFrom = i
    }
    dropped += keepFrom
    const messages: WorldMessage[] = clamped
      .slice(keepFrom)
      .map(({ role, content, truncated }) => ({
        role,
        content,
        ...(truncated ? { truncated: true as const } : {})
      }))
    return { id: s.id, title: s.title, messages, ...(dropped ? { droppedMessages: dropped } : {}) }
  })
  // total cap: drop OLDEST sessions first, count what fell (true UTF-8 bytes)
  let total = sessions.reduce(
    (n, s) => n + s.messages.reduce((m, x) => m + byteLen(x.content), 0),
    0
  )
  let droppedSessions = 0
  const survivors = [...sessions]
  while (total > clamps.totalMaxBytes && survivors.length > 1) {
    const gone = survivors.shift()!
    total -= gone.messages.reduce((m, x) => m + byteLen(x.content), 0)
    droppedSessions++
  }
  return { sessions: survivors, ...(droppedSessions ? { droppedSessions } : {}) }
}
