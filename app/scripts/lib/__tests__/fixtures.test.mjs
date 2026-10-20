import { afterEach, describe, expect, it } from 'vitest'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { openDb } from '../../../src/main/services/db'
import {
  FIXTURES_DIR,
  checkExpected,
  listFixtures,
  loadFixture,
  readActual,
  readFakeCalls,
  resolveStages,
  seedFixtureCase,
  writeFixtureAssets
} from '../fixtures.mjs'

const tmps = []
const tmp = () => {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), 'argus-fx-'))
  tmps.push(d)
  return d
}
const dbs = []
const freshDb = () => {
  const db = openDb(path.join(tmp(), 'argus.db'))
  dbs.push(db)
  return db
}
afterEach(() => {
  for (const db of dbs.splice(0)) db.close()
  for (const d of tmps.splice(0)) fs.rmSync(d, { recursive: true, force: true })
})

const HELPED = path.join(FIXTURES_DIR, 'fx-helped.json')
const readJson = (file) => JSON.parse(fs.readFileSync(file, 'utf8'))
const writeJson = (dir, name, obj) =>
  fs.writeFileSync(path.join(dir, name), JSON.stringify(obj, null, 2))
const fenceOf = (text) => JSON.parse(/```json\s*\n([\s\S]*?)\n```/.exec(text)[1])

const insertCase = (db, slug) =>
  Number(
    db
      .prepare(
        `INSERT INTO cases (slug, title, status, tags, created_at, updated_at) VALUES (?, ?, 'open', '[]', ?, ?)`
      )
      .run(slug, 'fixture case', '2026-10-20T00:00:00Z', '2026-10-20T00:00:00Z').lastInsertRowid
  )

describe('listFixtures', () => {
  it('loads and validates every shipped fixture', () => {
    const all = listFixtures()
    expect(all.length).toBeGreaterThanOrEqual(1)
    expect(all.map((f) => f.slug)).toContain('fx-helped')
  })

  it('rejects a skill name reused by a second fixture in the set', () => {
    const dir = tmp()
    const orig = readJson(HELPED)
    writeJson(dir, 'fx-helped.json', orig)
    // Everything else renamed, so the skill is the only collision.
    const dup = {
      ...orig,
      slug: 'fx-dup',
      assets: {
        skills: orig.assets.skills,
        references: [{ ...orig.assets.references[0], relPath: 'fx-dup.md' }],
        memories: ['fx-dup-topic']
      },
      // ...and its UI names follow the renamed assets (they must be the fixture's own)
      expected: {
        ...orig.expected,
        ui: {
          ...orig.expected.ui,
          observabilityLists: ['fx-helped-skill', 'fx-dup.md', 'fx-dup-topic']
        }
      }
    }
    writeJson(dir, 'fx-dup.json', dup)
    expect(() => listFixtures(dir)).toThrow(/unique/)
    expect(() => listFixtures(dir)).toThrow(/fx-helped-skill/)
  })

  it('rejects a placeholder whose index is out of range, naming it', () => {
    const dir = tmp()
    const fx = readJson(HELPED)
    fx.stages.dossier.text = fx.stages.dossier.text.replace('{{finding:0}}', '{{finding:9}}')
    writeJson(dir, 'fx-helped.json', fx)
    expect(() => listFixtures(dir)).toThrow(/fx-helped\.json: .*finding:9/)
  })

  it('ships exactly the ten pinned scenarios', () => {
    expect(
      listFixtures()
        .map((f) => f.slug)
        .sort()
    ).toEqual([
      'fx-declined',
      'fx-dossier-fail',
      'fx-helped',
      'fx-loaded',
      'fx-misled',
      'fx-negative',
      'fx-open',
      'fx-reject',
      'fx-retract',
      'fx-v2'
    ])
  })
})

describe('loadFixture validation (each a copy of fx-helped with one bad value)', () => {
  /** Write a mutated copy of fx-helped and return the loader's error message ('' when it loads). */
  const problemOfVariant = (mutate) => {
    const dir = tmp()
    const fx = readJson(HELPED)
    mutate(fx)
    writeJson(dir, 'fx-helped.json', fx)
    try {
      loadFixture(path.join(dir, 'fx-helped.json'))
      return ''
    } catch (e) {
      return e.message
    }
  }

  it('the unmodified copy loads (the baseline every case below differs from by one value)', () => {
    expect(problemOfVariant(() => {})).toBe('')
  })

  it('requires expected.attributionsJob when expected.attributions is non-empty', () => {
    expect(
      problemOfVariant((fx) => {
        delete fx.expected.attributionsJob
      })
    ).toMatch(/^fx-helped\.json: expected\.attributionsJob is required/)
  })

  it('rejects an expected.attributionsJob outside expected.jobs', () => {
    expect(
      problemOfVariant((fx) => {
        fx.expected.attributionsJob = 1
      })
    ).toMatch(/^fx-helped\.json: expected\.attributionsJob 1 is out of range \(1 expected jobs\)/)
  })

  it('rejects an expected.fakeCalls key that is not a fake stage', () => {
    expect(
      problemOfVariant((fx) => {
        fx.expected.fakeCalls.attributon = 0
      })
    ).toMatch(/^fx-helped\.json: expected\.fakeCalls: unknown stage "attributon"/)
  })

  it('rejects an expected.jobs[].stages entry that is not a compared stage key', () => {
    expect(
      problemOfVariant((fx) => {
        fx.expected.jobs[0].stages.push('dossierLite')
      })
    ).toMatch(/^fx-helped\.json: expected\.jobs\[0\]\.stages: unknown stage "dossierLite"/)
  })

  it('rejects a ui.observabilityLists name that is not one of the fixture’s assets', () => {
    expect(
      problemOfVariant((fx) => {
        fx.expected.ui.observabilityLists.push('fx-helped-skil')
      })
    ).toMatch(/^fx-helped\.json: expected\.ui\.observabilityLists: "fx-helped-skil" is not/)
  })

  it('rejects a ui.observabilityOmits name that is not one of the fixture’s assets', () => {
    expect(
      problemOfVariant((fx) => {
        fx.expected.ui.observabilityOmits.push('fx-nowhere-skill')
      })
    ).toMatch(/^fx-helped\.json: expected\.ui\.observabilityOmits: "fx-nowhere-skill" is not/)
  })

  it('rejects a ui.libraryChip.asset that is not one of the fixture’s assets', () => {
    expect(
      problemOfVariant((fx) => {
        fx.expected.ui.libraryChip.asset = 'fx-other-skill'
      })
    ).toMatch(/^fx-helped\.json: expected\.ui\.libraryChip\.asset: "fx-other-skill" is not/)
  })

  it('rejects a placeholder that is not wrapped in double quotes', () => {
    expect(
      problemOfVariant((fx) => {
        fx.stages.dossier.text = fx.stages.dossier.text.replace('"{{finding:0}}"', '{{finding:0}}')
      })
    ).toMatch(
      /^fx-helped\.json: stages: placeholder \{\{finding:0\}\} is not wrapped in double quotes/
    )
  })

  it('rejects a toolCalls turn of 0 (turns are 1-based)', () => {
    expect(
      problemOfVariant((fx) => {
        fx.toolCalls[0].turn = 0
      })
    ).toMatch(/^fx-helped\.json: toolCalls\[0\]\.turn 0 is not an integer in 1\.\./)
  })

  it('rejects a skill description a plain YAML scalar cannot carry', () => {
    expect(
      problemOfVariant((fx) => {
        fx.assets.skills[0].description = 'Use when: the uploader drops batches'
      })
    ).toMatch(/^fx-helped\.json: assets\.skills "fx-helped-skill": description must be/)
    expect(
      problemOfVariant((fx) => {
        fx.assets.skills[0].description = '# not a comment'
      })
    ).toMatch(/description must be/)
  })
})

describe('resolveStages', () => {
  it('replaces a quoted placeholder with the numeric row id inside the canned fence', () => {
    const fx = loadFixture(HELPED)
    const stages = resolveStages(fx, { sessionIds: [41, 42], findingIds: [77] })
    const dossier = fenceOf(stages.dossier.text)
    expect(typeof dossier.root_cause.cites[0].finding).toBe('number')
    expect(dossier.root_cause.cites[0].finding).toBe(77)
    expect(dossier.diagnostic_path[0].cites[0]).toEqual({ session: 41, turn: 1 })
    expect(JSON.stringify(stages)).not.toMatch(/\{\{/)
    // the fixture itself is untouched
    expect(fx.stages.dossier.text).toContain('{{finding:0}}')
  })

  it('throws on a placeholder the ids cannot satisfy', () => {
    const fx = loadFixture(HELPED)
    expect(() => resolveStages(fx, { sessionIds: [41, 42], findingIds: [] })).toThrow(/finding:0/)
  })
})

describe('seedFixtureCase', () => {
  it('seeds sessions, transcript, findings and tool calls, and refuses to seed twice', () => {
    const db = freshDb()
    const fx = loadFixture(HELPED)
    const caseId = insertCase(db, fx.slug)
    const ids = seedFixtureCase(db, caseId, fx)

    expect(ids.sessionIds).toHaveLength(fx.sessions.length)
    expect(ids.findingIds).toHaveLength(fx.findings.length)
    const sessions = db.prepare(`SELECT id FROM sessions WHERE case_id=? ORDER BY id`).all(caseId)
    expect(sessions.map((s) => Number(s.id))).toEqual(ids.sessionIds)
    fx.sessions.forEach((s, i) => {
      const n = db
        .prepare(`SELECT COUNT(*) AS n FROM messages_fts WHERE case_id=? AND session_id=?`)
        .get(caseId, ids.sessionIds[i]).n
      expect(Number(n)).toBe(s.messages.length)
      const mapped = db
        .prepare(`SELECT COUNT(*) AS n FROM messages_fts_map WHERE case_id=? AND session_id=?`)
        .get(caseId, ids.sessionIds[i]).n
      expect(Number(mapped)).toBe(s.messages.length)
    })

    const findings = db
      .prepare(
        `SELECT id, session_id, role, review_state FROM findings WHERE case_id=? ORDER BY id`
      )
      .all(caseId)
    expect(findings.map((f) => Number(f.id))).toEqual(ids.findingIds)
    fx.findings.forEach((f, i) => {
      expect(findings[i].role).toBe(f.role)
      expect(findings[i].review_state).toBe(f.reviewState)
      expect(Number(findings[i].session_id)).toBe(ids.sessionIds[f.session])
    })

    const calls = db
      .prepare(
        `SELECT session_id, turn_id, tool, detail, decision, risk, args_hash FROM tool_calls WHERE case_id=? ORDER BY id`
      )
      .all(caseId)
    expect(calls).toHaveLength(fx.toolCalls.length)
    fx.toolCalls.forEach((t, i) => {
      expect(calls[i]).toMatchObject({
        tool: t.tool,
        detail: t.detail,
        decision: 'auto',
        risk: 'LOW',
        args_hash: `fx-${i}`
      })
      expect(Number(calls[i].session_id)).toBe(ids.sessionIds[t.session])
      expect(Number(calls[i].turn_id)).toBe(t.turn)
    })

    expect(() => seedFixtureCase(db, caseId, fx)).toThrow(/already/)
  })

  it('is one transaction: a seed that fails on its last insert leaves nothing behind', () => {
    const db = freshDb()
    const fx = loadFixture(HELPED)
    const caseId = insertCase(db, fx.slug)
    const broken = structuredClone(fx)
    broken.toolCalls[broken.toolCalls.length - 1].tool = null // tool_calls.tool is NOT NULL
    expect(() => seedFixtureCase(db, caseId, broken)).toThrow(/NOT NULL/)
    const count = (table) =>
      Number(db.prepare(`SELECT COUNT(*) AS n FROM ${table} WHERE case_id=?`).get(caseId).n)
    for (const table of ['sessions', 'messages_fts_map', 'findings', 'tool_calls'])
      expect(count(table), table).toBe(0)
    // ...so the retry is not refused as a second seed
    expect(seedFixtureCase(db, caseId, fx).sessionIds).toHaveLength(fx.sessions.length)
  })
})

describe('writeFixtureAssets', () => {
  it('writes the user-tier skill and the reference with its trust_tier frontmatter', () => {
    const home = tmp()
    const fx = loadFixture(HELPED)
    writeFixtureAssets(home, fx)
    const skill = fs.readFileSync(
      path.join(home, 'skills-user', 'fx-helped-skill', 'SKILL.md'),
      'utf8'
    )
    expect(skill).toMatch(/^---\nname: fx-helped-skill\ndescription: .+\n---\n/)
    const ref = fs.readFileSync(path.join(home, 'references', 'fx-helped.md'), 'utf8')
    expect(ref).toMatch(/^---\ntrust_tier: team-knowledge\n---\n/)
  })
})

describe('readFakeCalls + readActual', () => {
  it('counts one slug’s calls by stage and reads only the latest attribution job’s rows', () => {
    const fakeDir = tmp()
    expect(readFakeCalls(fakeDir, 'fx-a')).toEqual({})
    fs.writeFileSync(
      path.join(fakeDir, 'calls.ndjson'),
      [
        { stage: 'dossier', slug: 'fx-a' },
        { stage: 'attribution', slug: 'fx-a' },
        { stage: 'attribution', slug: 'fx-a' },
        { stage: 'dossier', slug: 'fx-b' },
        { stage: 'rejectDigest', slug: null }
      ]
        .map((l) => JSON.stringify({ at: 'x', mode: 'text', ...l }))
        .join('\n') + '\n'
    )
    expect(readFakeCalls(fakeDir, 'fx-a')).toEqual({ dossier: 1, attribution: 2 })
    // A torn final line (read racing the app's append) is skipped; a torn middle line is not.
    const file = path.join(fakeDir, 'calls.ndjson')
    fs.appendFileSync(file, '{"at":"x","stage":"summ')
    expect(readFakeCalls(fakeDir, 'fx-a')).toEqual({ dossier: 1, attribution: 2 })
    fs.appendFileSync(file, '\n' + JSON.stringify({ stage: 'summary', slug: 'fx-a' }) + '\n')
    expect(() => readFakeCalls(fakeDir, 'fx-a')).toThrow()

    const db = freshDb()
    const caseId = insertCase(db, 'fx-a')
    const job = (kind, dry, stages) =>
      Number(
        db
          .prepare(
            `INSERT INTO distill_jobs (case_slug, state, input_snapshot, created_at, kind, dry_run, pipeline, stages_json, cost_usd)
             VALUES ('fx-a', 'done', '{}', 'now', ?, ?, 'v3', ?, 0.5)`
          )
          .run(kind, dry, stages === null ? null : JSON.stringify(stages)).lastInsertRowid
      )
    const row = (jobId, name) =>
      db
        .prepare(
          `INSERT INTO asset_attributions (case_id, job_id, asset_kind, asset_name, applied, verdict, cites_json, case_outcome, case_domain, created_at)
           VALUES (?, ?, 'skill', ?, 1, 'helped', '[{"finding":1}]', 'solved', 'FXA', 'now')`
        )
        .run(caseId, jobId, name)
    const older = job('case', 0, { dossier: {} })
    const newer = job('attribution', 0, null)
    const dry = job('case', 1, { dossier: {} })
    row(older, 'old-skill')
    row(newer, 'new-skill')
    row(dry, 'dry-skill') // highest id, but a dry run never owns the case's state

    const actual = readActual(db, 'fx-a', { dossier: 1 })
    expect(actual.jobs.map((j) => j.id)).toEqual([older, newer, dry])
    expect(actual.jobs[0].stages).toEqual({ dossier: {} })
    expect(actual.jobs[1].stages).toBeNull()
    expect(actual.rows.map((r) => r.name)).toEqual(['new-skill'])
    expect(actual.rows[0]).toMatchObject({ jobId: newer, cites: [{ finding: 1 }], applied: 1 })
    expect(actual.fakeCalls).toEqual({ dossier: 1 })
  })
})

describe('checkExpected', () => {
  const expected = () => ({
    jobs: [
      {
        kind: 'case',
        state: 'done',
        pipeline: 'v3',
        stages: ['dossier', 'summary', 'candidates', 'attribution', 'materialize'],
        attributionSkipped: null,
        attributionError: false,
        costUsd: 0.55
      },
      {
        kind: 'attribution',
        state: 'done',
        pipeline: null,
        stages: [],
        attributionSkipped: null,
        attributionError: false,
        costUsd: 0.1
      }
    ],
    attributions: [
      {
        kind: 'skill',
        name: 's',
        applied: 1,
        verdict: 'helped',
        override: null,
        domain: 'FXH',
        outcome: 'solved'
      },
      {
        kind: 'memory',
        name: 'm',
        applied: 0,
        verdict: null,
        override: null,
        domain: 'FXH',
        outcome: 'solved'
      }
    ],
    fakeCalls: { dossier: 1, attribution: 1, summary: 0 },
    ui: {
      libraryChip: null,
      observabilityLists: [],
      observabilityOmits: [],
      runsRailLabel: null,
      runDetailSkipped: null
    }
  })
  const actual = () => ({
    jobs: [
      {
        id: 1,
        kind: 'case',
        state: 'done',
        pipeline: 'v3',
        stages: {
          dossier: {},
          summary: {},
          candidates: {},
          attribution: {},
          materialize: [{}],
          dossierUncitedDropped: {}
        },
        costUsd: 0.55 + 1e-9,
        error: null
      },
      {
        id: 2,
        kind: 'attribution',
        state: 'done',
        pipeline: null,
        stages: null,
        costUsd: 0.1,
        error: null
      }
    ],
    rows: [
      {
        kind: 'memory',
        name: 'm',
        applied: 0,
        verdict: null,
        overrideVerdict: null,
        overrideSource: null,
        domain: 'FXH',
        outcome: 'solved',
        jobId: 1,
        cites: []
      },
      {
        kind: 'skill',
        name: 's',
        applied: 1,
        verdict: 'helped',
        overrideVerdict: null,
        overrideSource: null,
        domain: 'FXH',
        outcome: 'solved',
        jobId: 1,
        cites: [{ finding: 3 }]
      }
    ],
    fakeCalls: { dossier: 1, attribution: 1 }
  })

  it('returns no problems when actual matches expected', () => {
    expect(checkExpected(actual(), expected())).toEqual([])
  })

  it('reports a flipped verdict as one problem naming the row and field', () => {
    const a = actual()
    a.rows[1].verdict = 'misled'
    const problems = checkExpected(a, expected())
    expect(problems).toHaveLength(1)
    expect(problems[0]).toMatch(/skill\/s.*verdict.*helped.*misled/)
  })

  it('reports a dropped job as one problem naming the job count', () => {
    const a = actual()
    a.jobs.pop()
    const problems = checkExpected(a, expected())
    expect(problems).toHaveLength(1)
    expect(problems[0]).toMatch(/^jobs: expected 2, got 1/)
  })

  it('reports an added override as one problem naming the field', () => {
    const a = actual()
    a.rows[1].overrideVerdict = 'misled'
    a.rows[1].overrideSource = 'finding-retraction'
    const problems = checkExpected(a, expected())
    expect(problems).toHaveLength(1)
    expect(problems[0]).toMatch(/skill\/s.*override.*finding-retraction/)
  })

  it('reports a changed fake-call count as one problem naming the stage', () => {
    const a = actual()
    a.fakeCalls.attribution = 2
    const problems = checkExpected(a, expected())
    expect(problems).toHaveLength(1)
    expect(problems[0]).toMatch(/^fakeCalls\.attribution: expected 1, got 2/)
  })

  it('with attributionsJob set, passes when every row belongs to that job', () => {
    expect(checkExpected(actual(), { ...expected(), attributionsJob: 0 })).toEqual([])
  })

  it('reports a row owned by the wrong job as exactly one problem naming the row and both ids', () => {
    const a = actual()
    a.rows[1].jobId = 2
    const problems = checkExpected(a, { ...expected(), attributionsJob: 0 })
    expect(problems).toEqual(['attributions[skill/s].jobId: expected 1 (jobs[0]), got 2'])
  })

  it('reports a wrong attributionsJob index once per row, each naming the row and both ids', () => {
    const problems = checkExpected(actual(), { ...expected(), attributionsJob: 1 })
    expect(problems).toEqual([
      'attributions[memory/m].jobId: expected 2 (jobs[1]), got 1',
      'attributions[skill/s].jobId: expected 2 (jobs[1]), got 1'
    ])
  })

  it('reports an attributionsJob with no actual job as one problem', () => {
    const a = actual()
    a.jobs.pop()
    const problems = checkExpected(a, {
      ...expected(),
      jobs: [expected().jobs[0]],
      attributionsJob: 1
    })
    expect(problems).toEqual([
      'attributionsJob: expected jobs[1] to own the rows, but only 1 job(s) exist'
    ])
  })

  it('reports a failed job with its error, a missing row and an unexpected one', () => {
    const a = actual()
    a.jobs[0].state = 'failed'
    a.jobs[0].error = 'boom'
    a.rows[0].name = 'other'
    const problems = checkExpected(a, expected())
    expect(problems).toEqual([
      'jobs[0].state: expected done, got failed (error: boom)',
      expect.stringMatching(/^attributions\[memory\/m\]: missing/),
      expect.stringMatching(/^attributions\[memory\/other\]: unexpected/)
    ])
  })
})
