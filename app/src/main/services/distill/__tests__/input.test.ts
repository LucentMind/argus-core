import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { describe, it, expect, beforeEach } from 'vitest'
import type { DatabaseSync } from 'node:sqlite'
import { openDb } from '../../db'
import { createCase, setCaseStatus } from '../../caseService'
import { writeProposal, rejectProposal, acceptProposal } from '../../proposals'
import { assembleDistillInput, buildReferencesIndex, USER_MSG_CLAMP } from '../input'
import { sharedReferencesDir } from '../../skillsDir'
import { artifactsDir, proposalsArchiveDir } from '../../paths'
import type { RcaDraft } from '../../../../shared/rca'

let home: string
let db: DatabaseSync
beforeEach(() => {
  home = fs.mkdtempSync(path.join(os.tmpdir(), 'argus-home-'))
  db = openDb(path.join(home, 'argus.db'))
  createCase(db, home, { slug: 'case-a', title: 'DLT drift', jiraKey: 'AB-1' })
})

describe('assembleDistillInput', () => {
  it('collects meta, findings with review states, and already-captured knowledge', () => {
    // seed one finding row + body marker
    const caseId = (db.prepare(`SELECT id FROM cases WHERE slug='case-a'`).get() as { id: number })
      .id
    const r = db
      .prepare(
        `INSERT INTO findings (case_id, session_id, turn_id, summary, review_state, created_at)
       VALUES (?, NULL, NULL, 'Root cause found', 'accepted', '2026-07-16T00:00:00Z')`
      )
      .run(caseId)
    fs.appendFileSync(
      path.join(home, 'cases', 'case-a', 'findings.md'),
      `\n<!-- finding:${Number(r.lastInsertRowid)} -->\n## Root cause found\n\nClock resync.\n`
    )
    // in-case knowledge: one rejected proposal
    const pf = writeProposal(home, 'case-a', {
      type: 'reference-edit',
      target: 'dlt-cmds',
      title: 'Cmds',
      content: 'x'
    })
    rejectProposal(home, pf)
    setCaseStatus(db, home, 'case-a', 'closed', 'solved')

    const input = assembleDistillInput(db, home, 'case-a', [
      {
        name: 'analyze-dlt',
        description: 'DLT skill',
        content: '---\nname: analyze-dlt\n---\nbody'
      }
    ])
    expect(input.caseMeta).toMatchObject({ slug: 'case-a', jiraKey: 'AB-1', resolution: 'solved' })
    expect(input.findings).toEqual([
      {
        id: expect.any(Number),
        summary: 'Root cause found',
        reviewState: 'accepted',
        role: null,
        body: expect.stringContaining('Clock resync.')
      }
    ])
    expect(input.findings.every((f) => typeof f.id === 'number')).toBe(true)
    expect(input.skillsIndex).toEqual([
      {
        name: 'analyze-dlt',
        description: 'DLT skill',
        content: '---\nname: analyze-dlt\n---\nbody'
      }
    ])
    expect(input.alreadyCaptured.proposals).toEqual([
      { type: 'reference-edit', target: 'dlt-cmds', title: 'Cmds', state: 'rejected' }
    ])
  })

  it('throws on unknown case', () => {
    expect(() => assembleDistillInput(db, home, 'nope')).toThrow(/Unknown case/)
  })

  it('carries the case status into caseMeta', () => {
    expect(assembleDistillInput(db, home, 'case-a').caseMeta.status).toBe('open')
    setCaseStatus(db, home, 'case-a', 'closed', 'solved')
    expect(assembleDistillInput(db, home, 'case-a').caseMeta.status).toBe('closed')
  })

  it('carries a finding role and the confirmed RCA structure when present, null when absent', () => {
    const caseId = (db.prepare(`SELECT id FROM cases WHERE slug='case-a'`).get() as { id: number })
      .id
    const r = db
      .prepare(
        `INSERT INTO findings (case_id, session_id, turn_id, summary, review_state, created_at)
       VALUES (?, NULL, NULL, 'Root cause found', 'accepted', '2026-07-16T00:00:00Z')`
      )
      .run(caseId)
    const findingId = Number(r.lastInsertRowid)
    db.prepare(`UPDATE findings SET role = 'root-cause' WHERE id = ?`).run(findingId)

    // No artifacts/rca-structure.json yet → null.
    let input = assembleDistillInput(db, home, 'case-a')
    expect(input.findings).toEqual([expect.objectContaining({ role: 'root-cause' })])
    expect(input.rcaStructure).toBeNull()

    // A confirmed report writes artifacts/rca-structure.json — assembleDistillInput reads it.
    const draft: RcaDraft = {
      rootCause: { findingId, statement: 'clock resync missed', evidence: [] },
      contributing: [],
      symptoms: [],
      ruledOut: [],
      duplicates: [],
      impact: '',
      timeline: [],
      remediation: { immediate: '', followUps: [] },
      execSummary: { whatBroke: '', impact: '', why: '', nextSteps: '' },
      techNarrative: [],
      sections: {}
    }
    const dir = artifactsDir(home, 'case-a')
    fs.mkdirSync(dir, { recursive: true })
    fs.writeFileSync(path.join(dir, 'rca-structure.json'), JSON.stringify(draft))

    input = assembleDistillInput(db, home, 'case-a')
    expect(input.rcaStructure).toEqual(draft)
  })

  it('rcaStructure is null (not thrown) when the file exists but is not valid JSON', () => {
    const dir = artifactsDir(home, 'case-a')
    fs.mkdirSync(dir, { recursive: true })
    fs.writeFileSync(path.join(dir, 'rca-structure.json'), '{not valid json')

    const input = assembleDistillInput(db, home, 'case-a')
    expect(input.rcaStructure).toBeNull()
  })
})

describe('assembleDistillInput — v2 (user messages, reject annotations, operator guidance)', () => {
  function caseId(slug: string): number {
    return (db.prepare(`SELECT id FROM cases WHERE slug=?`).get(slug) as { id: number }).id
  }
  function insertSession(id: number, slug: string, title: string): void {
    db.prepare(
      `INSERT INTO sessions (id, case_id, title, turn_count, created_at, updated_at)
       VALUES (?, ?, ?, 0, '2026-01-01', '2026-01-01')`
    ).run(id, caseId(slug), title)
  }
  function indexMsg(
    sessionId: number,
    slug: string,
    turnId: number,
    role: string,
    content: string
  ): void {
    db.prepare(
      `INSERT INTO messages_fts (content, case_id, session_id, turn_id, role) VALUES (?,?,?,?,?)`
    ).run(content, caseId(slug), sessionId, turnId, role)
  }
  /** Overwrites an archived proposal's `date:` (CREATION time) frontmatter line directly on
   *  disk, so a tie-break test can pin creation order deterministically instead of relying on
   *  real wall-clock timestamps -- two writeProposal calls in the same test tick can land in the
   *  same millisecond, which would make the scenario non-deterministic otherwise. */
  function setArchivedDate(file: string, iso: string): void {
    const p = path.join(proposalsArchiveDir(home), file)
    const raw = fs.readFileSync(p, 'utf8')
    const patched = raw.replace(/^date: .*$/m, `date: ${iso}`)
    expect(patched).not.toBe(raw) // guard: fail loudly if the regex ever stops matching
    fs.writeFileSync(p, patched)
  }

  it('(a) keeps the last 25 user messages per session, newest session first, dropping zero-user-turn sessions', () => {
    // sessions 1-3: 30 user turns each. session 4: assistant-only, must be absent entirely.
    for (const sid of [1, 2, 3]) {
      insertSession(sid, 'case-a', `s${sid}`)
      for (let i = 1; i <= 30; i++) indexMsg(sid, 'case-a', i, 'user', `s${sid}-msg-${i}`)
    }
    insertSession(4, 'case-a', 's4')
    indexMsg(4, 'case-a', 1, 'assistant', 'no user turns here')

    const input = assembleDistillInput(db, home, 'case-a')

    expect(input.userMessages).toBeDefined()
    const groups = input.userMessages!
    // newest session first (id desc); the zero-user-turn session is absent, not an empty group
    expect(groups.map((g) => g.sessionTitle)).toEqual(['s3', 's2', 's1'])
    for (const g of groups) expect(g.messages).toHaveLength(25)
    // last 25 of 30 -> messages 6..30, in original order
    expect(groups[0].messages[0]).toBe('s3-msg-6')
    expect(groups[0].messages[24]).toBe('s3-msg-30')
    const total = groups.reduce((n, g) => n + g.messages.length, 0)
    expect(total).toBeLessThanOrEqual(100)
  })

  it('enforces the 100-message total budget mid-session, not just per-session (take shrinks below 25)', () => {
    // s5 (newest): only 10 available -- contributes all 10, total=10.
    insertSession(5, 'case-a', 's5')
    for (let i = 1; i <= 10; i++) indexMsg(5, 'case-a', i, 'user', `s5-msg-${i}`)
    // s4, s3, s2: 30 available each -- per-session cap of 25 applies, total=35,60,85.
    for (const sid of [4, 3, 2]) {
      insertSession(sid, 'case-a', `s${sid}`)
      for (let i = 1; i <= 30; i++) indexMsg(sid, 'case-a', i, 'user', `s${sid}-msg-${i}`)
    }
    // s1 (oldest): 30 available, but only 15 REMAIN in the total budget (100-85) -- the
    // USER_MSGS_TOTAL - total term, not the per-session cap, must be what limits this session.
    insertSession(1, 'case-a', 's1')
    for (let i = 1; i <= 30; i++) indexMsg(1, 'case-a', i, 'user', `s1-msg-${i}`)

    const input = assembleDistillInput(db, home, 'case-a')
    const groups = input.userMessages!

    expect(groups.map((g) => g.sessionTitle)).toEqual(['s5', 's4', 's3', 's2', 's1'])
    expect(groups.map((g) => g.messages.length)).toEqual([10, 25, 25, 25, 15])
    expect(groups.reduce((n, g) => n + g.messages.length, 0)).toBe(100)
    // s1 has 30 available, but only the LAST 15 survive the shrunk budget
    expect(groups[4].messages[0]).toBe('s1-msg-16')
    expect(groups[4].messages[14]).toBe('s1-msg-30')
  })

  it('(b) clamps a 12 000-char user message to head 3 000 + marker + tail 1 000', () => {
    insertSession(1, 'case-a', 's1')
    const big = 'x'.repeat(12_000)
    indexMsg(1, 'case-a', 1, 'user', big)

    const input = assembleDistillInput(db, home, 'case-a')

    const msg = input.userMessages![0].messages[0]
    const expectedOmitted = big.length - USER_MSG_CLAMP // 8_000
    const marker = `[… ${expectedOmitted} chars omitted]`
    expect(msg).toBe('x'.repeat(3_000) + marker + 'x'.repeat(1_000))
    // byte-check: real U+2026 ellipsis, no U+FFFD replacement char
    expect(msg.includes('…')).toBe(true)
    expect(msg.includes('�')).toBe(false)
    expect(msg.includes('...')).toBe(false)
  })

  it('(c) annotates a skill/reference entry whose latest proposal was rejected, cross-case; an accepted archive adds no note', () => {
    const dir = sharedReferencesDir(home)
    fs.mkdirSync(dir, { recursive: true })
    fs.writeFileSync(
      path.join(dir, 'brake-lore.md'),
      '---\ntitle: Brake Lore\ntrust_tier: team-knowledge\n---\n\nBrakes.\n'
    )
    fs.writeFileSync(
      path.join(dir, 'clutch-notes.md'),
      '---\ntitle: Clutch Notes\ntrust_tier: team-knowledge\n---\n\nClutch.\n'
    )

    // rejected reference-edit against brake-lore, filed under a DIFFERENT case
    const rejectedRef = writeProposal(home, 'other-case', {
      type: 'reference-edit',
      target: 'brake-lore',
      title: 'Widen brake note',
      content: 'Brakes, revised.\n'
    })
    rejectProposal(home, rejectedRef, { tag: 'overgeneric', note: 'too vague' })

    // accepted reference-edit against clutch-notes -- must NOT get a note
    const acceptedRef = writeProposal(home, 'case-a', {
      type: 'reference-edit',
      target: 'clutch-notes',
      title: 'Clutch tweak',
      content: 'Clutch, revised.\n'
    })
    acceptProposal(home, acceptedRef)

    // rejected skill-edit against analyze-dlt, same mechanism for skillsIndex
    const rejectedSkill = writeProposal(home, 'other-case', {
      type: 'skill-edit',
      target: 'analyze-dlt',
      title: 'Widen skill',
      content: 'body'
    })
    rejectProposal(home, rejectedSkill, { tag: 'wrong', note: 'incorrect steps' })

    const input = assembleDistillInput(db, home, 'case-a', [
      { name: 'analyze-dlt', description: 'DLT skill', content: 'body' }
    ])

    const brake = input.referencesIndex.find((r) => r.name === 'brake-lore')
    const clutch = input.referencesIndex.find((r) => r.name === 'clutch-notes')
    expect(brake?.note).toBe(
      'a proposed edit here was rejected as overgeneric (case other-case): too vague'
    )
    expect(clutch?.note).toBeUndefined()
    expect(input.skillsIndex[0].note).toBe(
      'a proposed edit here was rejected as wrong (case other-case): incorrect steps'
    )
  })

  it('tie-break: annotates with the note from the MOST RECENTLY REJECTED proposal, not the most recently CREATED one', () => {
    const dir = sharedReferencesDir(home)
    fs.mkdirSync(dir, { recursive: true })
    fs.writeFileSync(
      path.join(dir, 'brake-lore.md'),
      '---\ntitle: Brake Lore\ntrust_tier: team-knowledge\n---\n\nBrakes.\n'
    )

    const fileA = writeProposal(home, 'other-case', {
      type: 'reference-edit',
      target: 'brake-lore',
      title: 'A',
      content: 'A body'
    })
    const fileB = writeProposal(home, 'other-case', {
      type: 'reference-edit',
      target: 'brake-lore',
      title: 'B',
      content: 'B body'
    })
    // A is rejected LAST (latest rejectedAt) and B is rejected FIRST (earliest rejectedAt).
    rejectProposal(
      home,
      fileA,
      { tag: 'wrong', note: 'A note (rejected last, must win)' },
      new Date('2026-01-10T00:00:00.000Z')
    )
    rejectProposal(
      home,
      fileB,
      { tag: 'overfit', note: 'B note (rejected first, must lose)' },
      new Date('2026-01-03T00:00:00.000Z')
    )
    // A was created FIRST (earlier "date") and B created SECOND (later "date") -- pinned
    // directly on disk rather than relying on real timing, which can tie at 1ms resolution.
    // A sort keyed on creation date would process A(day1) then B(day2) ascending, so B's
    // Map.set happens last and wins (WRONG). A sort keyed on rejectedAt processes B(day3) then
    // A(day10) ascending, so A's Map.set happens last and wins -- correct, since A is the more
    // recently REJECTED proposal, which is the only thing that should matter.
    setArchivedDate(fileA, '2026-01-01T00:00:00.000Z')
    setArchivedDate(fileB, '2026-01-02T00:00:00.000Z')

    const input = assembleDistillInput(db, home, 'case-a')
    const brake = input.referencesIndex.find((r) => r.name === 'brake-lore')
    expect(brake?.note).toBe(
      'a proposed edit here was rejected as wrong (case other-case): A note (rejected last, must win)'
    )
  })

  it('(d) passes operatorGuidance through verbatim, omitting it when not supplied', () => {
    const withGuidance = assembleDistillInput(db, home, 'case-a', [], {
      operatorGuidance: 'Focus on timing bugs.'
    })
    expect(withGuidance.operatorGuidance).toBe('Focus on timing bugs.')

    const withoutGuidance = assembleDistillInput(db, home, 'case-a')
    expect(withoutGuidance.operatorGuidance).toBeUndefined()
  })

  it('(e) includes a world snapshot that JSON round-trips', () => {
    insertSession(1, 'case-a', 's1')
    indexMsg(1, 'case-a', 1, 'user', 'hello')

    const input = assembleDistillInput(db, home, 'case-a')

    expect(input.world).toBeDefined()
    expect(JSON.parse(JSON.stringify(input.world))).toEqual(input.world)
    expect(input.world!.sessions[0].messages).toEqual([{ role: 'user', content: 'hello' }])
  })
})

describe('buildReferencesIndex', () => {
  it('summarizes from the body paragraph, falling back to the title only when no body line exists', () => {
    const dir = sharedReferencesDir(home)
    fs.mkdirSync(dir, { recursive: true })
    // 1. Titled file whose body has a real paragraph line — summary is that
    //    paragraph, not a duplicate of the title.
    fs.writeFileSync(
      path.join(dir, 'titled.md'),
      '---\ntitle: DLT Drift Runbook\ntrust_tier: team-knowledge\n---\n\nRun the resync script before escalating.\n\nMore detail below.\n'
    )
    // 2. Untitled-summary case: content after frontmatter starts with a blank
    //    line, then a heading, then a paragraph — summary is the paragraph.
    fs.writeFileSync(
      path.join(dir, 'heading-first.md'),
      '---\ntitle: Heading First\ntrust_tier: team-knowledge\n---\n\n# Heading\n\nThe actual useful summary line.\n'
    )
    // 3. Only a heading and nothing else — falls back to the title text.
    fs.writeFileSync(
      path.join(dir, 'only-heading.md'),
      '---\ntitle: Only Heading Title\ntrust_tier: team-knowledge\n---\n\n# Just A Heading\n'
    )

    const index = buildReferencesIndex(home)
    expect(index).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          name: 'titled',
          summary: 'Run the resync script before escalating.'
        }),
        expect.objectContaining({
          name: 'heading-first',
          summary: 'The actual useful summary line.'
        }),
        expect.objectContaining({ name: 'only-heading', summary: 'Only Heading Title' })
      ])
    )
  })

  it('carries each reference trust_tier (confluence vs team-knowledge vs null)', () => {
    const dir = sharedReferencesDir(home)
    fs.mkdirSync(dir, { recursive: true })
    fs.writeFileSync(
      path.join(dir, 'synced.md'),
      '---\ntitle: Synced\ntrust_tier: confluence\n---\n\nFrom Confluence.\n'
    )
    fs.writeFileSync(
      path.join(dir, 'owned.md'),
      '---\ntitle: Owned\ntrust_tier: team-knowledge\n---\n\nHand written.\n'
    )
    fs.writeFileSync(path.join(dir, 'bare.md'), 'No frontmatter here.\n')

    const index = buildReferencesIndex(home)
    expect(index).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ name: 'synced', tier: 'confluence' }),
        expect.objectContaining({ name: 'owned', tier: 'team-knowledge' }),
        expect.objectContaining({ name: 'bare', tier: null })
      ])
    )
  })

  it('carries the full reference file content so a reference-edit can merge into it', () => {
    const dir = sharedReferencesDir(home)
    fs.mkdirSync(dir, { recursive: true })
    const raw = '---\ntitle: DLT Drift Runbook\ntrust_tier: team-knowledge\n---\n\nResync first.\n'
    fs.writeFileSync(path.join(dir, 'titled.md'), raw)

    const entry = buildReferencesIndex(home).find((r) => r.name === 'titled')
    expect(entry?.content).toBe(raw)
  })
})
