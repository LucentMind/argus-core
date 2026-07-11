import type { DatabaseSync } from 'node:sqlite'
import type { ChatHit, ChatSearchResult } from '../../shared/types'
import { getCase } from './caseService'
import { escapeFtsQuery } from './search'

const MAX_HITS = 50
const MAX_GLOBAL_HITS = 25

export function searchMessages(db: DatabaseSync, caseSlug: string, q: string): ChatSearchResult {
  if (!q.trim()) return { hits: [] }
  const rec = getCase(db, caseSlug)
  if (!rec) return { hits: [], error: `Unknown case: ${caseSlug}` }
  try {
    const rows = db
      .prepare(
        `SELECT session_id AS sessionId, turn_id AS turnId, role,
                snippet(messages_fts, 0, '«', '»', '…', 12) AS snippet
         FROM messages_fts
         WHERE messages_fts MATCH ? AND case_id = ?
         ORDER BY bm25(messages_fts)
         LIMIT ${MAX_HITS}`
      )
      .all(q, rec.id) as unknown as ChatSearchResult['hits']
    return { hits: rows }
  } catch (err) {
    // FTS5 syntax errors (unbalanced quotes etc.) — surface inline, never throw
    return { hits: [], error: (err as Error).message }
  }
}

interface AllRow {
  caseSlug: string
  sessionId: number | bigint
  sessionTitle: string
  turnId: number | bigint | null
  role: string
  snippet: string
}

/**
 * Cross-case chat search for the home search bar. Unlike searchMessages (raw
 * FTS syntax for the in-case SessionSwitcher), the query is term-escaped so a
 * casual unified-bar query can never hit an FTS syntax error.
 */
export function searchAllMessages(db: DatabaseSync, q: string, caseSlug?: string): ChatHit[] {
  if (!q.trim()) return []
  const slug = caseSlug ?? null
  try {
    const rows = db
      .prepare(
        `SELECT c.slug                    AS caseSlug,
                messages_fts.session_id   AS sessionId,
                COALESCE(s.title, '')     AS sessionTitle,
                messages_fts.turn_id      AS turnId,
                messages_fts.role         AS role,
                snippet(messages_fts, 0, '«', '»', '…', 12) AS snippet
         FROM messages_fts
         JOIN cases c    ON c.id = messages_fts.case_id
         LEFT JOIN sessions s ON s.id = messages_fts.session_id
         WHERE messages_fts MATCH ?
           AND (? IS NULL OR c.slug = ?)
         ORDER BY bm25(messages_fts)
         LIMIT ${MAX_GLOBAL_HITS}`
      )
      .all(escapeFtsQuery(q), slug, slug) as unknown as AllRow[]
    return rows.map((r) => ({
      kind: 'chat',
      caseSlug: r.caseSlug,
      sessionId: Number(r.sessionId),
      sessionTitle: r.sessionTitle,
      turnId: r.turnId === null ? null : Number(r.turnId),
      role: r.role,
      snippet: r.snippet
    }))
  } catch {
    // FTS5 syntax errors etc. — never throw across the search:query IPC
    return []
  }
}
