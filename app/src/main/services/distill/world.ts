import type { DatabaseSync } from 'node:sqlite'
import type { DistillWorld, WorldMessage, WorldSession } from '../../../shared/distill'

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
        `SELECT role, content FROM messages_fts WHERE case_id = ? AND session_id = ? ORDER BY rowid ASC`
      )
      .all(c.id, s.id) as { role: string; content: string }[]
    let kept = rows
    let dropped = 0
    if (kept.length > clamps.sessionMaxMsgs) {
      dropped = kept.length - clamps.sessionMaxMsgs
      kept = kept.slice(-clamps.sessionMaxMsgs) // late messages carry conclusions
    }
    const messages: WorldMessage[] = []
    let bytes = 0
    for (const r of kept) {
      const { text, truncated } = clampText(r.content, clamps.msgClamp)
      bytes += text.length
      if (bytes > clamps.sessionMaxBytes) {
        dropped++
        continue
      }
      messages.push({
        role: r.role,
        content: text,
        ...(truncated ? { truncated: true as const } : {})
      })
    }
    return { id: s.id, title: s.title, messages, ...(dropped ? { droppedMessages: dropped } : {}) }
  })
  // total cap: drop OLDEST sessions first, count what fell
  let total = sessions.reduce((n, s) => n + s.messages.reduce((m, x) => m + x.content.length, 0), 0)
  let droppedSessions = 0
  const survivors = [...sessions]
  while (total > clamps.totalMaxBytes && survivors.length > 1) {
    const gone = survivors.shift()!
    total -= gone.messages.reduce((m, x) => m + x.content.length, 0)
    droppedSessions++
  }
  return { sessions: survivors, ...(droppedSessions ? { droppedSessions } : {}) }
}
