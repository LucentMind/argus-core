import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { describe, it, expect, beforeEach } from 'vitest'
import type { DatabaseSync } from 'node:sqlite'
import { openDb } from '../../db'
import { createCase, getCase } from '../../caseService'
import { upsertCaseSummary } from '../../distill/summaries'
import { buildRelatedQuery, freeFormQuery, isStrong } from '../query'
import { SAMPLE_CASE_TITLE } from '../../../../shared/onboarding'

let home: string
let db: DatabaseSync

/** Insert a findings row directly. The real writer (`appendFinding` in
 *  agent/nativeTools.ts) also writes findings.md and takes a session context —
 *  none of which this query-builder test needs, and importing it would couple a
 *  pure retrieval test to the agent module. */
function addFinding(
  caseId: number,
  summary: string,
  opts: { reviewState?: string; role?: string | null; createdAt?: string } = {}
): void {
  db.prepare(
    `INSERT INTO findings (case_id, session_id, turn_id, summary, review_state, role, created_at)
     VALUES (?, NULL, NULL, ?, ?, ?, ?)`
  ).run(
    caseId,
    summary,
    opts.reviewState ?? 'pending',
    opts.role ?? null,
    opts.createdAt ?? new Date().toISOString()
  )
}

beforeEach(() => {
  home = fs.mkdtempSync(path.join(os.tmpdir(), 'argus-q-'))
  db = openDb(path.join(home, 'argus.db'))
})

describe('buildRelatedQuery', () => {
  it('uses title + jiraKey when the case has no accepted summary', () => {
    createCase(db, home, { slug: 'c1', title: 'Bearing jumps north', jiraKey: 'NAV-7' })
    const q = buildRelatedQuery(db, 'c1')
    expect(q.terms.map((t) => t.text)).toEqual(['Bearing', 'jumps', 'north', 'NAV-7'])
    expect(q.terms.map((t) => t.source)).toEqual(['title', 'title', 'title', 'jiraKey'])
    expect(q.text).toBe('Bearing jumps north NAV-7')
  })

  it('prefers the accepted summary signature and its terms over the title', () => {
    createCase(db, home, { slug: 'c2', title: 'Some vague title', jiraKey: 'NAV-8' })
    upsertCaseSummary(
      db,
      home,
      'c2',
      {
        signature: 'ECU reset drifts DLT',
        symptoms: 's',
        rootCause: 'r',
        fix: 'f',
        keywords: ['E_TIMEOUT_42']
      },
      'solved',
      'md'
    )
    const q = buildRelatedQuery(db, 'c2')
    expect(q.terms.map((t) => t.text)).toEqual(['ECU', 'reset', 'drifts', 'DLT', 'E_TIMEOUT_42'])
    expect(q.terms.at(-1)!.source).toBe('errorStrings')
    expect(q.terms.some((t) => t.text === 'vague')).toBe(false)
  })

  it('appends the three most recent finding summaries', () => {
    createCase(db, home, { slug: 'c3', title: 'T' })
    const id = getCase(db, 'c3')!.id
    addFinding(id, 'oldest alpha', { createdAt: '2026-01-01T00:00:00Z' })
    addFinding(id, 'second bravo', { createdAt: '2026-01-02T00:00:00Z' })
    addFinding(id, 'third charlie', { createdAt: '2026-01-03T00:00:00Z' })
    addFinding(id, 'newest delta', { createdAt: '2026-01-04T00:00:00Z' })
    const findingTerms = buildRelatedQuery(db, 'c3')
      .terms.filter((t) => t.source === 'finding')
      .map((t) => t.text)
    expect(findingTerms).toContain('delta')
    expect(findingTerms).toContain('charlie')
    expect(findingTerms).not.toContain('alpha')
  })

  it('ignores rejected and ruled-out findings — a disproved hypothesis must not steer retrieval', () => {
    createCase(db, home, { slug: 'c5', title: 'T' })
    const id = getCase(db, 'c5')!.id
    addFinding(id, 'rejected alpha', { reviewState: 'rejected' })
    addFinding(id, 'ruledout bravo', { role: 'ruled-out' })
    addFinding(id, 'good charlie', { reviewState: 'accepted' })
    const findingTerms = buildRelatedQuery(db, 'c5')
      .terms.filter((t) => t.source === 'finding')
      .map((t) => t.text)
    expect(findingTerms).toEqual(['good', 'charlie'])
  })

  it('de-duplicates tokens case-insensitively, keeping the first source', () => {
    createCase(db, home, { slug: 'c4', title: 'Reset reset RESET' })
    const q = buildRelatedQuery(db, 'c4')
    expect(q.terms).toHaveLength(1)
    expect(q.terms[0].source).toBe('title')
  })

  it('returns an empty query for an unknown slug', () => {
    expect(buildRelatedQuery(db, 'nope')).toEqual({ text: '', terms: [] })
  })

  it('yields exactly the four weak tokens for the seeded sample case', () => {
    createCase(db, home, { slug: 'sample-onboarding', title: SAMPLE_CASE_TITLE })
    const q = buildRelatedQuery(db, 'sample-onboarding')
    expect(q.terms.map((t) => t.text)).toEqual(['Sample:', 'guided', 'tour', 'case'])
  })
})

describe('freeFormQuery', () => {
  it('tokenises user text as non-strong terms', () => {
    const q = freeFormQuery('  charge plan  ')
    expect(q.terms).toEqual([
      { text: 'charge', source: 'free' },
      { text: 'plan', source: 'free' }
    ])
    expect(q.terms.every((t) => !isStrong(t))).toBe(true)
  })
})

describe('isStrong', () => {
  it('is true only for signature and errorStrings terms', () => {
    expect(isStrong({ text: 'x', source: 'signature' })).toBe(true)
    expect(isStrong({ text: 'x', source: 'errorStrings' })).toBe(true)
    expect(isStrong({ text: 'x', source: 'title' })).toBe(false)
    expect(isStrong({ text: 'x', source: 'finding' })).toBe(false)
    expect(isStrong({ text: 'x', source: 'free' })).toBe(false)
  })
})
