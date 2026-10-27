import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import type { DatabaseSync } from 'node:sqlite'
import { openDb } from '../db'
import { createCase } from '../caseService'
import { caseDir } from '../paths'
import {
  appendToFindingBody,
  replaceFindingBody,
  applyReportRoles,
  clearFindings,
  confirmedRootCauseOf,
  deleteFinding,
  listFindings,
  reviewFinding,
  updateFinding
} from '../findings'
import { parseHumanFindingPatch, describeUpdateRefusal } from '../../../shared/findingPatch'

let home: string
let db: DatabaseSync
let caseId: number
let otherCaseId: number

function seed(extra: Record<string, string | number | null> = {}, cid = caseId): number {
  const now = new Date().toISOString()
  const base: Record<string, string | number | null> = {
    case_id: cid,
    session_id: null,
    summary: 'Race in parser',
    review_state: 'pending',
    created_at: now,
    ...extra
  }
  const cols = Object.keys(base)
  const res = db
    .prepare(`INSERT INTO findings (${cols.join(', ')}) VALUES (${cols.map(() => '?').join(', ')})`)
    .run(...Object.values(base))
  return Number(res.lastInsertRowid)
}

const col = (id: number, name: string): unknown =>
  (db.prepare(`SELECT ${name} AS v FROM findings WHERE id = ?`).get(id) as { v: unknown }).v

beforeEach(() => {
  home = fs.mkdtempSync(path.join(os.tmpdir(), 'argus-update-'))
  db = openDb(path.join(home, 'argus.db'))
  caseId = createCase(db, home, { slug: 'CASE-A', title: 'A' }).id
  otherCaseId = createCase(db, home, { slug: 'CASE-B', title: 'B' }).id
})

afterEach(() => {
  db.close()
  fs.rmSync(home, { recursive: true, force: true })
})

describe('updateFinding', () => {
  it('refuses an unknown id and an empty patch, writing nothing', () => {
    expect(updateFinding(db, home, 999, { status: 'confirmed' }, { actor: 'agent' })).toEqual({
      ok: false,
      reason: 'unknown'
    })
    const id = seed()
    expect(updateFinding(db, home, id, {}, { actor: 'agent' })).toEqual({
      ok: false,
      reason: 'empty'
    })
    expect(updateFinding(db, home, id, { appendMarkdown: '  \n' }, { actor: 'agent' })).toEqual({
      ok: false,
      reason: 'empty'
    })
  })

  it('writes status, role with the actor as source, and caused_by; fires onUpdated with the row', () => {
    const parent = seed()
    const id = seed({ status: 'hypothesis' })
    const onUpdated = vi.fn()
    const res = updateFinding(
      db,
      home,
      id,
      { status: 'confirmed', role: 'symptom', causedBy: parent },
      { actor: 'agent', onUpdated }
    )
    expect(res.ok).toBe(true)
    if (!res.ok) return
    expect(res.row.status).toBe('confirmed')
    expect(res.row.role).toBe('symptom')
    expect(res.row.roleSource).toBe('agent')
    expect(res.row.causedBy).toBe(parent)
    expect(onUpdated).toHaveBeenCalledWith(res.row)
    const h = updateFinding(db, home, id, { role: 'contributing' }, { actor: 'human' })
    expect(h.ok && h.row.roleSource).toBe('human')
    const cleared = updateFinding(db, home, id, { role: null, causedBy: null }, { actor: 'human' })
    expect(cleared.ok && cleared.row.role).toBeNull()
    expect(col(id, 'role_source')).toBeNull()
    expect(col(id, 'caused_by')).toBeNull()
  })

  it('appends a dated Update section inside the finding block of findings.md', () => {
    const id = seed()
    const md = path.join(caseDir(home, 'CASE-A'), 'findings.md')
    fs.writeFileSync(
      md,
      `# Findings — CASE-A\n\n<!-- finding:${id} -->\n## Race in parser\n_t · session 1_\n\nFirst body.\n\n<!-- finding:${id + 50} -->\n## Other\n\nOther body.\n`
    )
    const res = updateFinding(
      db,
      home,
      id,
      { appendMarkdown: 'Seen again at [evidence/log.txt:9].' },
      { actor: 'agent' }
    )
    expect(res.ok).toBe(true)
    const out = fs.readFileSync(md, 'utf8')
    const mine = out.split(`<!-- finding:${id + 50} -->`)[0]
    expect(mine).toMatch(
      /### Update \d{4}-\d{2}-\d{2}T[^\n]+\n\nSeen again at \[evidence\/log\.txt:9\]\.\n/
    )
    expect(out.split('<!-- finding:')).toHaveLength(3) // no block added, none lost
    expect(listFindings(db, home, 'CASE-A').find((f) => f.id === id)?.body).toContain('Seen again')
  })

  it('refuses a self cause, a cross-case cause and a cycle', () => {
    const a = seed()
    const b = seed({ caused_by: a })
    const c = seed({ caused_by: b })
    const foreign = seed({}, otherCaseId)
    expect(updateFinding(db, home, a, { causedBy: a }, { actor: 'human' })).toEqual({
      ok: false,
      reason: 'self-cause'
    })
    expect(updateFinding(db, home, a, { causedBy: foreign }, { actor: 'human' })).toEqual({
      ok: false,
      reason: 'bad-cause'
    })
    expect(updateFinding(db, home, a, { causedBy: 4242 }, { actor: 'human' })).toEqual({
      ok: false,
      reason: 'bad-cause'
    })
    // a ← b ← c; making a caused by c closes the loop
    expect(updateFinding(db, home, a, { causedBy: c }, { actor: 'agent' })).toEqual({
      ok: false,
      reason: 'cycle'
    })
    expect(col(a, 'caused_by')).toBeNull()
  })

  it('allows one confirmed root cause; a rejected or superseded one does not block', () => {
    const first = seed({ role: 'root-cause', role_source: 'agent' }) // status NULL = confirmed
    const second = seed()
    expect(updateFinding(db, home, second, { role: 'root-cause' }, { actor: 'agent' })).toEqual({
      ok: false,
      reason: 'second-root',
      existingRoot: first
    })
    // A root-cause HYPOTHESIS may coexist.
    const hyp = updateFinding(
      db,
      home,
      second,
      { role: 'root-cause', status: 'hypothesis' },
      { actor: 'agent' }
    )
    expect(hyp.ok).toBe(true)
    // Promoting it is the same refusal.
    expect(
      updateFinding(db, home, second, { status: 'confirmed' }, { actor: 'agent' })
    ).toMatchObject({
      ok: false,
      reason: 'second-root'
    })
    db.prepare(`UPDATE findings SET review_state = 'rejected' WHERE id = ?`).run(first)
    expect(updateFinding(db, home, second, { status: 'confirmed' }, { actor: 'agent' }).ok).toBe(
      true
    )
  })

  it('a superseded confirmed root cause does not block a new one', () => {
    const replacement = seed()
    seed({ role: 'root-cause', role_source: 'agent', superseded_by: replacement })
    const res = updateFinding(db, home, replacement, { role: 'root-cause' }, { actor: 'agent' })
    expect(res.ok && res.row.role).toBe('root-cause')
  })

  it('second-root is a transition check: a finding that already is the confirmed root keeps taking evidence', () => {
    const a = seed({ role: 'root-cause', role_source: 'agent' })
    const b = seed()
    const c = seed()
    // The human rules A out; the agent confirms B as the root; the human takes A back.
    reviewFinding(db, a, 'rejected')
    expect(updateFinding(db, home, b, { role: 'root-cause' }, { actor: 'agent' }).ok).toBe(true)
    reviewFinding(db, a, 'pending')
    // Two confirmed roots now stand, but a patch that moves neither into the role is not refused.
    expect(
      updateFinding(db, home, b, { appendMarkdown: 'More evidence.' }, { actor: 'agent' }).ok
    ).toBe(true)
    expect(
      updateFinding(db, home, a, { appendMarkdown: 'More evidence.' }, { actor: 'agent' }).ok
    ).toBe(true)
    // A third finding moving INTO the confirmed root role is still refused.
    expect(
      updateFinding(db, home, c, { role: 'root-cause', status: 'confirmed' }, { actor: 'agent' })
    ).toMatchObject({ ok: false, reason: 'second-root' })
    expect(col(c, 'role')).toBeNull()
  })

  it('still calls onUpdated, then throws, when the findings.md write fails after the row changed', () => {
    const id = seed({ status: 'hypothesis' })
    const md = path.join(caseDir(home, 'CASE-A'), 'findings.md')
    fs.rmSync(md, { force: true })
    fs.mkdirSync(md) // a directory at the path: the read throws EISDIR, not ENOENT
    const onUpdated = vi.fn()
    expect(() =>
      updateFinding(
        db,
        home,
        id,
        { status: 'confirmed', appendMarkdown: 'Evidence.' },
        { actor: 'agent', onUpdated }
      )
    ).toThrow()
    expect(col(id, 'status')).toBe('confirmed')
    expect(onUpdated).toHaveBeenCalledTimes(1)
    expect(onUpdated.mock.calls[0][0]).toMatchObject({ id, status: 'confirmed' })
  })

  it('a refusal or an invalid value writes nothing: row and findings.md are unchanged', () => {
    const md = path.join(caseDir(home, 'CASE-A'), 'findings.md')
    const accepted = seed({ review_state: 'accepted', review_actor: 'human', status: 'confirmed' })
    const mdBefore = fs.readFileSync(md)
    expect(
      updateFinding(
        db,
        home,
        accepted,
        { status: 'hypothesis', appendMarkdown: 'x' },
        { actor: 'agent' }
      )
    ).toEqual({ ok: false, reason: 'accepted-locked' })
    expect(fs.readFileSync(md).equals(mdBefore)).toBe(true)
    expect(col(accepted, 'status')).toBe('confirmed')

    const id = seed({ status: 'hypothesis' })
    expect(() =>
      updateFinding(
        db,
        home,
        id,
        { status: 'bogus' as never, appendMarkdown: 'x' },
        { actor: 'agent' }
      )
    ).toThrow(/Invalid status/)
    expect(() =>
      updateFinding(
        db,
        home,
        id,
        { role: 'bogus' as never, appendMarkdown: 'x' },
        { actor: 'human' }
      )
    ).toThrow(/Invalid role/)
    expect(fs.readFileSync(md).equals(mdBefore)).toBe(true)
    expect(col(id, 'status')).toBe('hypothesis')
    expect(col(id, 'role')).toBeNull()
    expect(col(id, 'role_source')).toBeNull()
  })

  it("locks an accepted finding's status and role to the agent, not its cause or evidence; the human is free", () => {
    const parent = seed()
    const id = seed({
      review_state: 'accepted',
      review_actor: 'human',
      role: 'symptom',
      role_source: 'agent'
    })
    expect(updateFinding(db, home, id, { status: 'hypothesis' }, { actor: 'agent' })).toEqual({
      ok: false,
      reason: 'accepted-locked'
    })
    expect(updateFinding(db, home, id, { role: 'contributing' }, { actor: 'agent' })).toEqual({
      ok: false,
      reason: 'accepted-locked'
    })
    expect(updateFinding(db, home, id, { causedBy: parent }, { actor: 'agent' }).ok).toBe(true)
    expect(updateFinding(db, home, id, { role: 'contributing' }, { actor: 'human' }).ok).toBe(true)
  })

  it('replaceMarkdown rewrites the body; append and replace together are refused; an accepted finding keeps its body from the agent', () => {
    const id = seed({ summary: 'Race' })
    fs.writeFileSync(
      path.join(caseDir(home, 'CASE-A'), 'findings.md'),
      `# Findings\n\n<!-- finding:${id} -->\n## Race\n_x_\n\nold [evidence/.derived/a.txt:1]\n`
    )
    expect(
      updateFinding(
        db,
        home,
        id,
        { replaceMarkdown: 'fixed [evidence/a.txt:1]' },
        { actor: 'agent' }
      )
    ).toMatchObject({ ok: true })
    expect(
      listFindings(db, home, 'CASE-A')
        .find((f) => f.id === id)
        ?.body?.trim()
    ).toBe('fixed [evidence/a.txt:1]')
    expect(
      updateFinding(db, home, id, { appendMarkdown: 'a', replaceMarkdown: 'b' }, { actor: 'agent' })
    ).toEqual({ ok: false, reason: 'both-bodies' })
    reviewFinding(db, id, 'accepted')
    expect(updateFinding(db, home, id, { replaceMarkdown: 'c' }, { actor: 'agent' })).toEqual({
      ok: false,
      reason: 'accepted-locked'
    })
    expect(
      updateFinding(db, home, id, { appendMarkdown: 'still allowed' }, { actor: 'agent' })
    ).toMatchObject({ ok: true })
    expect(describeUpdateRefusal('both-bodies')).toBe('Append or replace the body, not both.')
  })

  it('refuses the agent, not the human, on an rca-sourced role', () => {
    const id = seed({ role: 'contributing', role_source: 'rca' })
    expect(updateFinding(db, home, id, { role: 'symptom' }, { actor: 'agent' })).toEqual({
      ok: false,
      reason: 'rca-frozen'
    })
    expect(updateFinding(db, home, id, { status: 'hypothesis' }, { actor: 'agent' }).ok).toBe(true)
    const h = updateFinding(db, home, id, { role: 'symptom' }, { actor: 'human' })
    expect(h.ok && h.row.roleSource).toBe('human')
  })

  it('escapes markers in appended and replaced bodies', () => {
    const id = seed({ summary: 'Race' })
    updateFinding(db, home, id, { appendMarkdown: 'ref <!-- finding:3 -->' }, { actor: 'agent' })
    updateFinding(db, home, id, { replaceMarkdown: 'now <!-- finding:4 -->' }, { actor: 'agent' })
    const md = fs.readFileSync(path.join(caseDir(home, 'CASE-A'), 'findings.md'), 'utf8')
    expect(md.split('<!-- finding:')).toHaveLength(2)
    expect(md).toContain('now <!-- finding-ref:4 -->')
    expect(listFindings(db, home, 'CASE-A')).toHaveLength(1)
  })
})

describe('review-mode findings take no chain fields', () => {
  const session = (mode: 'investigation' | 'review'): number => {
    const now = new Date().toISOString()
    return Number(
      db
        .prepare(`INSERT INTO sessions (case_id, mode, created_at, updated_at) VALUES (?, ?, ?, ?)`)
        .run(caseId, mode, now, now).lastInsertRowid
    )
  }

  it('refuses status, role and cause on a review row for either actor, writing nothing; evidence appends stay allowed', () => {
    const rev = session('review')
    const other = seed({ session_id: rev })
    const id = seed({ session_id: rev, summary: 'Off-by-one in pager' })
    const mdPath = path.join(caseDir(home, 'CASE-A'), 'findings.md')
    fs.writeFileSync(
      mdPath,
      `# Findings

<!-- finding:${id} -->
## Off-by-one in pager
`
    )
    const onUpdated = vi.fn()
    for (const actor of ['agent', 'human'] as const) {
      for (const patch of [
        { role: 'root-cause' as const },
        { status: 'hypothesis' as const },
        { causedBy: other },
        { role: 'symptom' as const, appendMarkdown: 'More.' }
      ]) {
        expect(updateFinding(db, home, id, patch, { actor, onUpdated })).toEqual({
          ok: false,
          reason: 'review-mode'
        })
      }
    }
    expect(onUpdated).not.toHaveBeenCalled()
    expect(col(id, 'role')).toBeNull()
    expect(col(id, 'role_source')).toBeNull()
    expect(col(id, 'status')).toBeNull()
    expect(col(id, 'caused_by')).toBeNull()
    expect(fs.readFileSync(mdPath, 'utf8')).not.toContain('### Update')

    const res = updateFinding(
      db,
      home,
      id,
      { appendMarkdown: 'Also hits the last page.' },
      {
        actor: 'agent'
      }
    )
    expect(res.ok).toBe(true)
    expect(fs.readFileSync(mdPath, 'utf8')).toContain('Also hits the last page.')
  })

  it('a review-mode confirmed root never counts as the case root', () => {
    const rev = session('review')
    const inv = session('investigation')
    const revRoot = seed({ session_id: rev, role: 'root-cause', status: 'confirmed' })
    expect(confirmedRootCauseOf(db, caseId)).toBeNull()
    const invId = seed({ session_id: inv })
    const res = updateFinding(
      db,
      home,
      invId,
      { role: 'root-cause', status: 'confirmed' },
      {
        actor: 'agent'
      }
    )
    expect(res.ok).toBe(true)
    expect(confirmedRootCauseOf(db, caseId)).toBe(invId)
    // A session-less row reads as investigation, exactly as every finding read derives it.
    expect(confirmedRootCauseOf(db, caseId, invId)).toBeNull()
    const legacy = seed({ role: 'root-cause' })
    expect(confirmedRootCauseOf(db, caseId, invId)).toBe(legacy)
    expect(col(revRoot, 'role')).toBe('root-cause')
  })

  it('describes the refusal for the card', () => {
    expect(describeUpdateRefusal('review-mode')).toBe(
      'This finding belongs to a review session; status, role and cause apply to investigation findings only.'
    )
  })
})

describe('edges are nulled when their target goes', () => {
  it('deleteFinding clears caused_by and superseded_by that pointed at it', () => {
    const gone = seed()
    const child = seed({ caused_by: gone })
    const old = seed({ superseded_by: gone })
    fs.writeFileSync(path.join(caseDir(home, 'CASE-A'), 'findings.md'), '# Findings\n')
    deleteFinding(db, home, gone)
    expect(col(child, 'caused_by')).toBeNull()
    expect(col(old, 'superseded_by')).toBeNull()
  })

  it('a mode-scoped clear clears edges into the cleared set only', () => {
    const now = new Date().toISOString()
    const inv = Number(
      db
        .prepare(
          `INSERT INTO sessions (case_id, mode, created_at, updated_at) VALUES (?, 'investigation', ?, ?)`
        )
        .run(caseId, now, now).lastInsertRowid
    )
    const rev = Number(
      db
        .prepare(
          `INSERT INTO sessions (case_id, mode, created_at, updated_at) VALUES (?, 'review', ?, ?)`
        )
        .run(caseId, now, now).lastInsertRowid
    )
    const invRoot = seed({ session_id: inv })
    const invChild = seed({ session_id: inv, caused_by: invRoot })
    const revRoot = seed({ session_id: rev })
    const revChild = seed({ session_id: rev, caused_by: revRoot })
    // A surviving finding whose edges point INTO the cleared set loses them.
    const crossChild = seed({ session_id: inv, caused_by: revRoot, superseded_by: revChild })
    clearFindings(db, home, 'CASE-A', 'review')
    expect(col(invChild, 'caused_by')).toBe(invRoot)
    expect(db.prepare(`SELECT id FROM findings WHERE id = ?`).get(revChild)).toBeUndefined()
    expect(col(crossChild, 'caused_by')).toBeNull()
    expect(col(crossChild, 'superseded_by')).toBeNull()
  })
})

describe('applyReportRoles provenance', () => {
  it('stamps role_source rca on every assigned role and clears it with the role', () => {
    const a = seed({ role: 'symptom', role_source: 'human' })
    const b = seed()
    applyReportRoles(db, caseId, [{ findingId: b, role: 'root-cause' }])
    expect(col(b, 'role_source')).toBe('rca')
    expect(col(a, 'role')).toBeNull()
    expect(col(a, 'role_source')).toBeNull()
  })
})

describe('appendToFindingBody', () => {
  it('adds a block when the finding has none', () => {
    const out = appendToFindingBody(
      '# Findings\n',
      7,
      'New evidence.',
      'Race',
      new Date('2026-10-26T10:00:00Z')
    )
    expect(out).toBe(
      '# Findings\n\n<!-- finding:7 -->\n## Race\n_2026-10-26T10:00:00.000Z_\n\n### Update 2026-10-26T10:00:00.000Z\n\nNew evidence.\n'
    )
  })
})

describe('replaceFindingBody', () => {
  const md =
    '# Findings\n\n<!-- finding:7 -->\n## Race\n_2026-10-26T10:00:00.000Z · session 3_\n\nold body\n\n### Update 2026-10-26T11:00:00.000Z\n\nmore\n\n<!-- finding:8 -->\n## Other\n_x_\n\nkeep\n'
  it('replaces everything under the heading and meta line, leaving the other blocks alone', () => {
    expect(replaceFindingBody(md, 7, 'new body [evidence/a.log:3]', 'Race')).toBe(
      '# Findings\n\n<!-- finding:7 -->\n## Race\n_2026-10-26T10:00:00.000Z · session 3_\n\nnew body [evidence/a.log:3]\n\n<!-- finding:8 -->\n## Other\n_x_\n\nkeep\n'
    )
  })
  it('adds a block when the finding has none', () => {
    expect(
      replaceFindingBody('# Findings\n', 9, 'fresh', 'Nine', new Date('2026-10-27T10:00:00Z'))
    ).toBe('# Findings\n\n<!-- finding:9 -->\n## Nine\n_2026-10-27T10:00:00.000Z_\n\nfresh\n')
  })
})

describe('parseHumanFindingPatch', () => {
  it('accepts role and causedBy only, null included, and throws on anything else', () => {
    expect(parseHumanFindingPatch({ role: 'symptom' })).toEqual({ role: 'symptom' })
    expect(parseHumanFindingPatch({ role: null, causedBy: 3 })).toEqual({ role: null, causedBy: 3 })
    expect(parseHumanFindingPatch({ causedBy: null })).toEqual({ causedBy: null })
    expect(() => parseHumanFindingPatch({ status: 'hypothesis' })).toThrow(/status/)
    expect(() => parseHumanFindingPatch({ role: 'boss' })).toThrow(/role/)
    expect(() => parseHumanFindingPatch({ causedBy: 1.5 })).toThrow(/causedBy/)
    expect(() => parseHumanFindingPatch({})).toThrow(/empty/)
    expect(() => parseHumanFindingPatch('x')).toThrow()
  })
})

describe('describeUpdateRefusal', () => {
  it('words every refusal for the card, naming the existing root', () => {
    expect(describeUpdateRefusal('second-root', 6)).toBe(
      'Finding #6 is already the confirmed root cause — change its role first.'
    )
    expect(describeUpdateRefusal('cycle')).toBe('That would make a loop in the chain.')
    expect(describeUpdateRefusal('self-cause')).toBe('A finding cannot be caused by itself.')
    expect(describeUpdateRefusal('bad-cause')).toBe(
      'The cause must be another finding of this case.'
    )
    expect(describeUpdateRefusal('unknown')).toBe('That finding no longer exists.')
  })
})
