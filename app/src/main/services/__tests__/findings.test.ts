import { describe, it, expect } from 'vitest'
import { openDb } from '../db'
import { listFindings, reviewFinding } from '../findings'

function seedCase(db: ReturnType<typeof openDb>): number {
  const now = new Date().toISOString()
  const r = db
    .prepare(
      `INSERT INTO cases (slug, title, status, tags, created_at, updated_at) VALUES ('c1','C1','open','[]',?,?)`
    )
    .run(now, now)
  return Number(r.lastInsertRowid)
}

describe('findings service', () => {
  it('lists findings for a case and reviews them', () => {
    const db = openDb(':memory:')
    const caseId = seedCase(db)
    const now = new Date().toISOString()
    const r = db
      .prepare(
        `INSERT INTO findings (case_id, session_id, turn_id, summary, review_state, created_at) VALUES (?,?,?,?, 'pending', ?)`
      )
      .run(caseId, 1, 2, 'Root cause X', now)
    const id = Number(r.lastInsertRowid)

    const list = listFindings(db, 'c1')
    expect(list).toHaveLength(1)
    expect(list[0]).toMatchObject({ id, summary: 'Root cause X', reviewState: 'pending' })

    const reviewed = reviewFinding(db, id, 'accepted')
    expect(reviewed?.reviewState).toBe('accepted')
    expect(reviewed?.reviewedAt).not.toBeNull()
  })

  it('rejects an invalid review state', () => {
    const db = openDb(':memory:')
    // @ts-expect-error invalid state
    expect(() => reviewFinding(db, 1, 'bogus')).toThrow()
  })
})
