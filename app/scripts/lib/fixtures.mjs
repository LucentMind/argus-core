// Distillation fixture loader (spec 2026-10-20 §4.3). Plain Node ESM: node:fs/node:path only,
// no app imports — a DatabaseSync is always passed in, never opened here. It is the bridge
// between a fixture JSON under scripts/fixtures/distill/ and its two consumers (the vitest
// fixture suite and the deterministic CDP gate): validate the set, seed a case's transcript,
// resolve id placeholders into the per-case stage file the fake runner reads, and compare the
// DB afterwards against the fixture's `expected` block. Types: fixtures.d.mts (keep in step).
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

export const FIXTURES_DIR = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  '..',
  'fixtures',
  'distill'
)

const REQUIRED_KEYS = [
  'slug',
  'title',
  'jiraKey',
  'scenario',
  'settings',
  'assets',
  'sessions',
  'findings',
  'toolCalls',
  'close',
  'stages',
  'actions',
  'expected'
]
/** Any `{{…}}` token in the stage text; each must also match PLACEHOLDER. */
const ANY_TOKEN = /\{\{[^}]*\}\}/g
const PLACEHOLDER = /^\{\{(finding|session):(\d+)\}\}$/
/** Stage keys checkExpected compares by presence (spec §4.3). */
const STAGE_KEYS = ['dossier', 'summary', 'candidates', 'attribution', 'materialize']
/** The fake's case-scoped stages (FakeStage in fakeRunner.ts minus `rejectDigest`): the only
 *  keys calls.ndjson can count PER CASE, so a misspelt `expected.fakeCalls` key would assert
 *  "never called" vacuously. `rejectDigest` is deliberately absent: the fake logs a digest call
 *  with `slug: null` (a digest belongs to no case), so `readFakeCalls(dir, slug)` can never see
 *  one and `fakeCalls.rejectDigest: 0` could only ever pass. */
const FAKE_STAGES = [
  'dossier',
  'dossierLite',
  'summary',
  'candidates',
  'attribution',
  'materialize',
  'v2'
]

const isObj = (v) => typeof v === 'object' && v !== null && !Array.isArray(v)
const isIndex = (v, len) => Number.isInteger(v) && v >= 0 && v < len

/** The first problem with one fixture on its own, or null. */
function problemOf(fx) {
  if (!isObj(fx)) return 'not a JSON object'
  for (const k of REQUIRED_KEYS) if (!(k in fx)) return `missing required key "${k}"`
  if (typeof fx.slug !== 'string' || !fx.slug) return 'slug must be a non-empty string'
  if (!isObj(fx.settings) || !['v2', 'v3'].includes(fx.settings.pipeline))
    return 'settings.pipeline must be "v2" or "v3"'
  const a = fx.assets
  if (
    !isObj(a) ||
    !Array.isArray(a.skills) ||
    !Array.isArray(a.references) ||
    !Array.isArray(a.memories)
  )
    return 'assets needs skills, references and memories arrays'
  // The writer emits `description:` as a plain YAML scalar, and parseDescription
  // (shared/skillFrontmatter.ts) returns the inline value verbatim — it strips no quotes, so a
  // quoted scalar is not an option. Refuse what a plain scalar cannot carry instead.
  for (const s of a.skills) {
    const d = s?.description
    if (typeof d !== 'string' || !d.trim() || /: |[\r\n]/.test(d) || d.startsWith('#'))
      return `assets.skills ${JSON.stringify(s?.name)}: description must be a non-empty single line with no ": " and no leading "#" (it is written as a plain YAML scalar)`
  }
  if (!Array.isArray(fx.sessions) || fx.sessions.length < 1)
    return 'sessions needs at least 1 session'
  for (const [i, s] of fx.sessions.entries())
    if (!isObj(s) || !Array.isArray(s.messages)) return `sessions[${i}].messages must be an array`
  if (!Array.isArray(fx.findings)) return 'findings must be an array'
  for (const [i, f] of fx.findings.entries())
    if (!isIndex(f?.session, fx.sessions.length))
      return `findings[${i}].session ${f?.session} is out of range (${fx.sessions.length} sessions)`
  if (!Array.isArray(fx.toolCalls)) return 'toolCalls must be an array'
  for (const [i, t] of fx.toolCalls.entries()) {
    if (!isIndex(t?.session, fx.sessions.length))
      return `toolCalls[${i}].session ${t?.session} is out of range (${fx.sessions.length} sessions)`
    const n = fx.sessions[t.session].messages.length
    if (!Number.isInteger(t.turn) || t.turn < 1 || t.turn > n)
      return `toolCalls[${i}].turn ${t.turn} is not an integer in 1..${n} (1-based; session ${t.session} has ${n} messages)`
  }
  if (fx.trigger !== undefined && fx.trigger !== 'redistill')
    return `trigger must be "redistill", got ${JSON.stringify(fx.trigger)}`
  if ((fx.close !== null) === (fx.trigger !== undefined))
    return 'exactly one of close (non-null) and trigger must be set'
  if (!isObj(fx.stages)) return 'stages must be an object'
  const limits = { finding: fx.findings.length, session: fx.sessions.length }
  const serialized = JSON.stringify(fx.stages)
  for (const hit of serialized.matchAll(ANY_TOKEN)) {
    const token = hit[0]
    const m = PLACEHOLDER.exec(token)
    if (!m) return `stages: malformed placeholder ${token} (want {{finding:i}} or {{session:i}})`
    if (Number(m[2]) >= limits[m[1]])
      return `stages: placeholder ${token} is out of range (${limits[m[1]]} ${m[1]}s)`
    // resolveStages replaces only the quoted form, which inside a serialized stage text reads
    // as \"{{…}}\"; anything else would survive to its "was not resolved" error at seed time.
    const end = hit.index + token.length
    if (
      serialized.slice(hit.index - 2, hit.index) !== '\\"' ||
      serialized.slice(end, end + 2) !== '\\"'
    )
      return `stages: placeholder ${token} is not wrapped in double quotes (write "${token}" inside the stage text)`
  }
  if (!Array.isArray(fx.actions)) return 'actions must be an array'
  const e = fx.expected
  if (!isObj(e) || !Array.isArray(e.jobs) || e.jobs.length === 0)
    return 'expected.jobs must be a non-empty array'
  for (const [i, j] of e.jobs.entries()) {
    if (!isObj(j) || !Array.isArray(j.stages)) return `expected.jobs[${i}].stages must be an array`
    const bad = j.stages.find((s) => !STAGE_KEYS.includes(s))
    if (bad !== undefined)
      return `expected.jobs[${i}].stages: unknown stage ${JSON.stringify(bad)} (want one of ${STAGE_KEYS.join(', ')})`
  }
  if (!Array.isArray(e.attributions)) return 'expected.attributions must be an array'
  if (e.attributions.length > 0 && e.attributionsJob === undefined)
    return 'expected.attributionsJob is required when expected.attributions is non-empty (index into expected.jobs of the job owning the rows)'
  if (e.attributionsJob !== undefined && !isIndex(e.attributionsJob, e.jobs.length))
    return `expected.attributionsJob ${JSON.stringify(e.attributionsJob)} is out of range (${e.jobs.length} expected jobs)`
  if (!isObj(e.fakeCalls)) return 'expected.fakeCalls must be an object'
  const badCall = Object.keys(e.fakeCalls).find((k) => !FAKE_STAGES.includes(k))
  if (badCall !== undefined)
    return `expected.fakeCalls: unknown stage ${JSON.stringify(badCall)} (want one of ${FAKE_STAGES.join(', ')})`
  if (!isObj(e.ui)) return 'expected.ui must be an object'
  const own = new Set([
    ...a.skills.map((s) => s.name),
    ...a.references.map((r) => r.relPath),
    ...a.memories
  ])
  const named = [
    ...(e.ui.observabilityLists ?? []).map((n) => ['ui.observabilityLists', n]),
    ...(e.ui.observabilityOmits ?? []).map((n) => ['ui.observabilityOmits', n]),
    ...(e.ui.libraryChip ? [['ui.libraryChip.asset', e.ui.libraryChip.asset]] : [])
  ]
  for (const [where, n] of named)
    if (!own.has(n))
      return `expected.${where}: ${JSON.stringify(n)} is not one of this fixture's asset names`
  return null
}

/** Read, parse and validate one fixture file on its own. Throws `<file>: <problem>`. */
export function loadFixture(file) {
  const name = path.basename(file)
  let fx
  try {
    fx = JSON.parse(fs.readFileSync(file, 'utf8'))
  } catch (e) {
    throw new Error(`${name}: ${e.message}`)
  }
  const problem = problemOf(fx)
  if (problem) throw new Error(`${name}: ${problem}`)
  return fx
}

/** Every `*.json` fixture in `dir`, sorted by file name, each validated, plus the set-wide rule:
 *  slugs and asset names (skills by name, references by relPath, memories by name) are unique
 *  across the set. Throws on the first problem. */
export function listFixtures(dir = FIXTURES_DIR) {
  const files = fs
    .readdirSync(dir)
    .filter((f) => f.endsWith('.json'))
    .sort()
  const owners = new Map()
  const claim = (file, what, value) => {
    const key = `${what} ${JSON.stringify(value)}`
    const prior = owners.get(key)
    if (prior) throw new Error(`${file}: ${key} is not unique (also in ${prior})`)
    owners.set(key, file)
  }
  return files.map((file) => {
    const fx = loadFixture(path.join(dir, file))
    claim(file, 'slug', fx.slug)
    for (const s of fx.assets.skills) claim(file, 'skill name', s.name)
    for (const r of fx.assets.references) claim(file, 'reference relPath', r.relPath)
    for (const m of fx.assets.memories) claim(file, 'memory name', m)
    return fx
  })
}

const withNewline = (s) => (s.endsWith('\n') ? s : s + '\n')

/** User-tier skills at `<home>/skills-user/<name>/SKILL.md` and references at
 *  `<home>/references/<relPath>` with `trust_tier` frontmatter (the tier source the distill
 *  input reads). Memories are names only: a memory read needs no file. */
export function writeFixtureAssets(home, fx) {
  for (const s of fx.assets.skills) {
    const dir = path.join(home, 'skills-user', s.name)
    fs.mkdirSync(dir, { recursive: true })
    fs.writeFileSync(
      path.join(dir, 'SKILL.md'),
      withNewline(
        ['---', `name: ${s.name}`, `description: ${s.description}`, '---', '', s.body].join('\n')
      )
    )
  }
  for (const r of fx.assets.references) {
    const file = path.join(home, 'references', ...r.relPath.split('/'))
    fs.mkdirSync(path.dirname(file), { recursive: true })
    const head = r.tier === null ? [] : ['---', `trust_tier: ${r.tier}`, '---', '']
    fs.writeFileSync(file, withNewline([...head, r.body].join('\n')))
  }
}

/** The transcript seed of cdp-attribution.mjs's seedTranscript, driven by the fixture: sessions,
 *  messages_fts + messages_fts_map (one running turn_id per case), findings with role, then
 *  tool_calls (the inventory). Refuses a case that already has sessions. */
export function seedFixtureCase(db, caseId, fx) {
  const now = new Date().toISOString()
  db.exec(`PRAGMA foreign_keys = ON;`)
  // One transaction: a seed that throws half-way (a bad role, a FK miss) leaves no partial
  // transcript behind for the next attempt's "already has sessions" refusal to trip on.
  // IMMEDIATE takes the write lock up front: a deferred read-then-write upgrade in WAL mode can
  // fail SQLITE_BUSY_SNAPSHOT while the app writes, which busy_timeout does not retry.
  db.exec('BEGIN IMMEDIATE')
  try {
    const ids = seedInTransaction(db, caseId, fx, now)
    db.exec('COMMIT')
    return ids
  } catch (e) {
    try {
      db.exec('ROLLBACK')
    } catch {
      /* SQLite already rolled back (some errors end the transaction themselves) */
    }
    throw e
  }
}

function seedInTransaction(db, caseId, fx, now) {
  const already = db.prepare(`SELECT COUNT(*) AS n FROM sessions WHERE case_id=?`).get(caseId)
  if (Number(already.n) > 0)
    throw new Error(
      `case ${caseId} already has ${already.n} session(s); refusing to seed ${fx.slug} twice`
    )
  const insSession = db.prepare(
    `INSERT INTO sessions (case_id, driver_kind, title, turn_count, created_at, updated_at) VALUES (?, 'claude-agent-sdk', ?, 0, ?, ?)`
  )
  const insMsg = db.prepare(
    `INSERT INTO messages_fts (content, case_id, session_id, turn_id, role) VALUES (?, ?, ?, ?, ?)`
  )
  const insMap = db.prepare(
    `INSERT INTO messages_fts_map (fts_rowid, case_id, session_id) VALUES (?, ?, ?)`
  )
  let turn = 1
  const sessionIds = fx.sessions.map((s) => {
    const sid = Number(insSession.run(caseId, s.title, now, now).lastInsertRowid)
    for (const m of s.messages) {
      const rowid = Number(insMsg.run(m.content, caseId, sid, turn++, m.role).lastInsertRowid)
      insMap.run(rowid, caseId, sid)
    }
    return sid
  })
  const insFinding = db.prepare(
    `INSERT INTO findings (case_id, session_id, summary, review_state, role, created_at)
     VALUES (?, ?, ?, ?, ?, ?)`
  )
  const findingIds = fx.findings.map((f) =>
    Number(
      insFinding.run(caseId, sessionIds[f.session], f.summary, f.reviewState, f.role, now)
        .lastInsertRowid
    )
  )
  const insTool = db.prepare(
    `INSERT INTO tool_calls (case_id, session_id, turn_id, tool, args_hash, detail, risk, decision, created_at)
     VALUES (?, ?, ?, ?, ?, ?, 'LOW', 'auto', ?)`
  )
  fx.toolCalls.forEach((t, i) =>
    insTool.run(caseId, sessionIds[t.session], t.turn, t.tool, `fx-${i}`, t.detail, now)
  )
  return { sessionIds, findingIds }
}

/** A copy of `fx.stages` with every quoted placeholder replaced by its numeric row id: the
 *  quotes go too, so `{"finding":"{{finding:0}}"}` becomes `{"finding":12}`. Stage text is a
 *  string, so inside the serialized stages the quotes are escaped (`\"{{finding:0}}\"`). */
export function resolveStages(fx, ids) {
  const pools = { finding: ids.findingIds, session: ids.sessionIds }
  const resolved = JSON.stringify(fx.stages).replace(
    /\\"\{\{(finding|session):(\d+)\}\}\\"/g,
    (token, kind, i) => {
      const id = pools[kind][Number(i)]
      if (id === undefined)
        throw new Error(
          `${fx.slug}: placeholder {{${kind}:${i}}} has no seeded ${kind} (${pools[kind].length} seeded)`
        )
      return String(id)
    }
  )
  const left = resolved.match(ANY_TOKEN)
  if (left)
    throw new Error(
      `${fx.slug}: placeholder ${left[0]} was not resolved (placeholders must be quoted, e.g. "{{finding:0}}")`
    )
  return JSON.parse(resolved)
}

/** `<fakeDir>/<slug>.json`, the per-case file the fake runner reads on every call. */
export function writeFakeStages(fakeDir, slug, stages) {
  fs.mkdirSync(fakeDir, { recursive: true })
  const file = path.join(fakeDir, `${slug}.json`)
  fs.writeFileSync(file, JSON.stringify(stages, null, 2) + '\n')
  return file
}

/** The `distill` settings patch a consumer applies before running the fixture. */
export function settingsFor(fx) {
  return { pipeline: fx.settings.pipeline, attribution: { default: true } }
}

/** Per-stage call counts for one slug from the fake's `calls.ndjson`; `{}` when absent. A line
 *  with a null slug (every reject digest) never matches a case. An unparseable final line is
 *  skipped: it is a torn read while the app appends. */
export function readFakeCalls(fakeDir, slug) {
  const file = path.join(fakeDir, 'calls.ndjson')
  if (!fs.existsSync(file)) return {}
  const counts = {}
  const lines = fs.readFileSync(file, 'utf8').split(/\r?\n/)
  for (const [i, line] of lines.entries()) {
    if (!line.trim()) continue
    let call
    try {
      call = JSON.parse(line)
    } catch (e) {
      // The app appends while the gate polls: a torn LAST line is a read racing a write and is
      // counted on the next poll. A torn line anywhere else is real corruption.
      if (lines.slice(i + 1).every((l) => !l.trim())) continue
      throw e
    }
    if (call.slug !== slug) continue
    counts[call.stage] = (counts[call.stage] ?? 0) + 1
  }
  return counts
}

const parseOrNull = (text) => (text === null || text === undefined ? null : JSON.parse(text))

/** The DB state checkExpected compares: every distill_jobs row for the slug, by id, and the
 *  attribution rows of the case's latest job. "Latest" restates LATEST_JOB_PER_CASE in
 *  attributions.ts: the job owning MAX(asset_attributions.id) among non-dry jobs, NOT
 *  MAX(job_id) (retry reuses a job id). */
export function readActual(db, slug, fakeCalls) {
  const jobs = db
    .prepare(
      `SELECT id, kind, state, pipeline, stages_json, cost_usd, error FROM distill_jobs WHERE case_slug = ? ORDER BY id`
    )
    .all(slug)
    .map((j) => ({
      id: Number(j.id),
      kind: j.kind,
      state: j.state,
      pipeline: j.pipeline,
      stages: parseOrNull(j.stages_json),
      costUsd: j.cost_usd,
      error: j.error
    }))
  const rows = db
    .prepare(
      `SELECT a.* FROM asset_attributions a JOIN cases c ON c.id = a.case_id
       WHERE c.slug = ? AND a.job_id = (
         SELECT y.job_id FROM asset_attributions y JOIN distill_jobs dj ON dj.id = y.job_id
         WHERE y.case_id = c.id AND dj.dry_run = 0 ORDER BY y.id DESC LIMIT 1)
       ORDER BY a.id`
    )
    .all(slug)
    .map((r) => ({
      kind: r.asset_kind,
      name: r.asset_name,
      applied: r.applied,
      verdict: r.verdict,
      overrideVerdict: r.override_verdict,
      overrideSource: r.override_source,
      domain: r.case_domain,
      outcome: r.case_outcome,
      jobId: Number(r.job_id),
      cites: JSON.parse(r.cites_json)
    }))
  return { jobs, rows, fakeCalls }
}

const fmt = (v) =>
  v === null || v === undefined ? 'null' : typeof v === 'object' ? JSON.stringify(v) : String(v)

/** The presence-only stage keys of one job's stages (a null v2 row reads as `{}`). */
function stageKeysOf(stages) {
  const s = stages ?? {}
  return STAGE_KEYS.filter((k) =>
    k === 'materialize'
      ? Array.isArray(s[k]) && s[k].length > 0
      : s[k] !== undefined && s[k] !== null
  )
}

/** Pure comparator: `[]` when `actual` satisfies `expected`, else one readable line per problem.
 *  UI expectations are not compared here — the CDP gate reads them itself. */
export function checkExpected(actual, expected) {
  const problems = []
  const diff = (where, want, got, extra = '') => {
    if (fmt(want) !== fmt(got))
      problems.push(`${where}: expected ${fmt(want)}, got ${fmt(got)}${extra}`)
  }

  if (actual.jobs.length !== expected.jobs.length)
    problems.push(`jobs: expected ${expected.jobs.length}, got ${actual.jobs.length}`)
  const n = Math.min(actual.jobs.length, expected.jobs.length)
  for (let i = 0; i < n; i++) {
    const want = expected.jobs[i]
    const got = actual.jobs[i]
    const stages = got.stages ?? {}
    diff(`jobs[${i}].kind`, want.kind, got.kind)
    diff(`jobs[${i}].state`, want.state, got.state, got.error ? ` (error: ${got.error})` : '')
    diff(`jobs[${i}].pipeline`, want.pipeline, got.pipeline)
    diff(`jobs[${i}].stages`, [...want.stages].sort(), stageKeysOf(got.stages).sort())
    diff(
      `jobs[${i}].attributionSkipped`,
      want.attributionSkipped,
      stages.attributionSkipped ?? null
    )
    diff(
      `jobs[${i}].attributionError`,
      want.attributionError,
      stages.attribution?.error !== undefined
    )
    if (typeof got.costUsd !== 'number' || Math.abs(got.costUsd - want.costUsd) > 1e-6)
      problems.push(`jobs[${i}].costUsd: expected ${want.costUsd}, got ${fmt(got.costUsd)}`)
  }

  const key = (r) => `${r.kind}/${r.name}`
  // Ownership: readActual reads "the latest job's rows", so without this a row written by the
  // wrong job (the case job instead of the escape hatch, say) passes every field check.
  if (expected.attributionsJob !== undefined) {
    const owner = actual.jobs[expected.attributionsJob]
    if (!owner)
      problems.push(
        `attributionsJob: expected jobs[${expected.attributionsJob}] to own the rows, but only ${actual.jobs.length} job(s) exist`
      )
    else
      for (const r of actual.rows)
        if (r.jobId !== owner.id)
          problems.push(
            `attributions[${key(r)}].jobId: expected ${owner.id} (jobs[${expected.attributionsJob}]), got ${r.jobId}`
          )
  }
  const gotRows = new Map()
  for (const r of actual.rows) {
    if (gotRows.has(key(r)))
      problems.push(`attributions[${key(r)}]: duplicate row on the latest job`)
    gotRows.set(key(r), r)
  }
  const wantKeys = new Set()
  for (const want of expected.attributions) {
    const k = key(want)
    wantKeys.add(k)
    const got = gotRows.get(k)
    if (!got) {
      problems.push(
        `attributions[${k}]: missing (expected applied ${fmt(want.applied)}, verdict ${fmt(want.verdict)})`
      )
      continue
    }
    const override =
      got.overrideVerdict === null && got.overrideSource === null
        ? null
        : { verdict: got.overrideVerdict, source: got.overrideSource }
    diff(`attributions[${k}].applied`, want.applied, got.applied)
    diff(`attributions[${k}].verdict`, want.verdict, got.verdict)
    const wantOverride =
      want.override === null
        ? null
        : { verdict: want.override.verdict, source: want.override.source }
    diff(`attributions[${k}].override`, wantOverride, override)
    diff(`attributions[${k}].domain`, want.domain, got.domain)
    diff(`attributions[${k}].outcome`, want.outcome, got.outcome)
  }
  for (const [k, got] of gotRows)
    if (!wantKeys.has(k))
      problems.push(
        `attributions[${k}]: unexpected row (applied ${fmt(got.applied)}, verdict ${fmt(got.verdict)})`
      )

  for (const [stage, want] of Object.entries(expected.fakeCalls))
    diff(`fakeCalls.${stage}`, want, actual.fakeCalls[stage] ?? 0)
  return problems
}
