import { describe, it, expect } from 'vitest'
import { openDb } from '../../db'
import { globalMetrics, caseMetrics } from '../metrics'

function seed(db: ReturnType<typeof openDb>): void {
  const now = new Date().toISOString()
  db.prepare(`INSERT INTO cases (id, slug, title, status, tags, created_at, updated_at) VALUES (1,'c1','C1','closed','[]',?,?)`).run(now, now)
  db.prepare(`INSERT INTO turns (case_id, session_id, turn_index, status, input_tokens, output_tokens, cost_usd, duration_ms, model, created_at)
              VALUES (1,1,0,'success',100,50,0.02,1200,'claude-opus-4-8',?)`).run(now)
  db.prepare(`INSERT INTO turns (case_id, session_id, turn_index, status, input_tokens, output_tokens, cost_usd, duration_ms, model, created_at)
              VALUES (1,1,1,'error',NULL,NULL,NULL,NULL,NULL,?)`).run(now)
  db.prepare(`INSERT INTO tool_calls (case_id, session_id, turn_id, tool, args_hash, risk, decision, duration_ms, created_at)
              VALUES (1,1,1,'Bash','h','MEDIUM','user',5,?)`).run(now)
  db.prepare(`INSERT INTO tool_calls (case_id, session_id, turn_id, tool, args_hash, risk, decision, duration_ms, created_at)
              VALUES (1,1,1,'Bash','h','MEDIUM','denied',5,?)`).run(now)
  db.prepare(`INSERT INTO findings (case_id, session_id, turn_id, summary, review_state, created_at) VALUES (1,1,1,'F1','accepted',?)`).run(now)
  db.prepare(`INSERT INTO findings (case_id, session_id, turn_id, summary, review_state, created_at) VALUES (1,1,1,'F2','pending',?)`).run(now)
}

describe('metrics aggregation', () => {
  it('computes global metrics with NULL cost treated as unknown', () => {
    const db = openDb(':memory:')
    seed(db)
    const m = globalMetrics(db)
    expect(m.totalCostUsd).toBeCloseTo(0.02)
    expect(m.inputTokens).toBe(100)
    expect(m.turns).toEqual({ total: 2, error: 1 })
    expect(m.byModel).toEqual([{ model: 'claude-opus-4-8', inputTokens: 100, outputTokens: 50, costUsd: 0.02 }])
    expect(m.tools.total).toBe(2)
    expect(m.tools.denied).toBe(1)
    expect(m.tools.byDecision).toMatchObject({ user: 1, denied: 1 })
    expect(m.findings).toMatchObject({ total: 2, accepted: 1, pending: 1, rejected: 0 })
    expect(m.resolvedCases).toBe(1)
    expect(m.costPerResolvedCaseUsd).toBeCloseTo(0.02)
    expect(m.latencyMs.turnP50).toBe(1200)
  })

  it('scopes per-case metrics', () => {
    const db = openDb(':memory:')
    seed(db)
    const m = caseMetrics(db, 'c1')
    expect(m.totalCostUsd).toBeCloseTo(0.02)
    expect(m.findings.total).toBe(2)
  })
})
