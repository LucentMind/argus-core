import { describe, it, expect } from 'vitest'
import { openDb } from '../db'
import { globalMetrics } from '../observability/metrics'
import { listFindings, reviewFinding } from '../findings'

describe('metrics/findings handlers (logic)', () => {
  it('review then aggregate reflects acceptance', () => {
    const db = openDb(':memory:')
    const now = new Date().toISOString()
    db.prepare(
      `INSERT INTO cases (id, slug, title, status, tags, created_at, updated_at) VALUES (1,'c1','C1','open','[]',?,?)`
    ).run(now, now)
    const r = db
      .prepare(
        `INSERT INTO findings (case_id, session_id, turn_id, summary, review_state, created_at) VALUES (1,1,1,'F','pending',?)`
      )
      .run(now)
    reviewFinding(db, Number(r.lastInsertRowid), 'accepted')
    expect(listFindings(db, 'c1')[0].reviewState).toBe('accepted')
    expect(globalMetrics(db).findings.accepted).toBe(1)
  })
})
