import type { DatabaseSync } from 'node:sqlite'
import type { ChatSearchResult } from '../../shared/types'
import { getCase } from './caseService'

const MAX_HITS = 50

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
