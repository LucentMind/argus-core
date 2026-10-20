#!/usr/bin/env node
/**
 * Knowledge-asset attribution live gate — drives the REAL app over CDP against a scratch ARGUS_HOME.
 *
 * Modelled on `cdp-distill-v3.mjs` (same identity gate, same fixture shape, same real Claude SDK
 * run), pointed at the attribution stage. Three fixture cases, closed one after another because
 * the distill queue is global and runs one job at a time:
 *
 *   1. live-attr-positive — `tool_calls` rows for a Skill (`diagnose-uploader`) and a reference
 *      (`ref:nav/limits.md`), and both files on disk so the tiers resolve. Closed with
 *      distillation AND attribution. Expect one `kind='case'` job whose `stages_json.attribution`
 *      is present and error-free, and `asset_attributions` rows for both assets.
 *   2. live-attr-negative — the SAME transcript (which still names the skill in prose) but NO
 *      `tool_calls` rows. Closed with both. Expect `attributionSkipped === 'no-assets'`, zero rows
 *      and no attribution job. This is the negative control: the inventory comes from
 *      `tool_calls`, never from what the transcript says (argus-vacuous-live-assertions).
 *   3. live-attr-nodistill — like 1, closed with distillation UNTICKED and attribution ticked.
 *      Expect NO `kind='case'` job and exactly one `kind='attribution'` job (the escape hatch)
 *      carrying `stages_json.dossier` + `stages_json.attribution`, listed in the runs view with
 *      the `attribution only` label.
 *
 * Closing goes through the same preload call the close dialog uses:
 *   window.argus.cases.setStatus(slug, 'closed', 'solved', distill, attribution)
 *
 * Usage:
 *   1. ARGUS_HOME=<scratch> npx electron-vite dev -- --remote-debugging-port=9250
 *   2. ARGUS_HOME=<scratch> CDP_PORT=9250 node scripts/cdp-attribution.mjs
 *
 * Optional: LANGFUSE_SECRET_KEY (with Langfuse enabled + host + publicKey in the scratch home's
 * settings) lets the gate read the `asset.contribution` scores back from the Langfuse API. Without
 * a configured Langfuse it prints `langfuse: not configured, skipped` and records NO assertion; a
 * trailing `langfuse: skipped` line just before the tally makes that visible. The read-back is
 * scoped to this gate's run (`fromTimestamp` = gate start, and the fixture slugs in the score
 * metadata), so scores from an earlier run can never satisfy it.
 *
 * Spend: three real runs (~$2.6 each for the two full pipelines, less for the lite one). The gate
 * aborts with exit 2 BEFORE closing case 3 if cases 1+2 together cost more than $8 — after the
 * case 1/2 assertions have run, so a budget abort still prints them.
 *
 * Exits 0 when every check passes, 1 otherwise, 2 on an abort (identity / settings / spend).
 */
import { DatabaseSync } from 'node:sqlite'
import fs from 'node:fs'
import path from 'node:path'
import { listTargets, connect, mainWindow, sleep, waitFor, check, report } from './lib/cdp.mjs'

const PORT = process.env.CDP_PORT || '9250'
const HOME = process.env.ARGUS_HOME
if (!HOME) {
  console.error('ARGUS_HOME is required (the scratch home the app was booted against)')
  process.exit(2)
}
const DB = path.join(HOME, 'argus.db')
const SPEND_LIMIT_USD = 8
const JOB_TIMEOUT_MS = 25 * 60 * 1000

const SKILL = 'diagnose-uploader'
const REF = 'nav/limits.md'

const POSITIVE = 'live-attr-positive'
const NEGATIVE = 'live-attr-negative'
const NODISTILL = 'live-attr-nodistill'
const GATE_START_ISO = new Date().toISOString()
const FIXTURES = [
  { slug: POSITIVE, jiraKey: 'LIVE-81', tools: true },
  { slug: NEGATIVE, jiraKey: 'LIVE-82', tools: false },
  { slug: NODISTILL, jiraKey: 'LIVE-83', tools: true }
]

// ---------- settings ----------
/**
 * Force `distill.pipeline = 'v3'` and `distill.attribution.default = true` in the scratch home's
 * settings file. Merged into whatever is there: `SettingsService` falls back to ALL defaults on a
 * parse failure, so clobbering a valid file would silently reset the rest of the home.
 */
function forceSettings() {
  const file = path.join(HOME, 'config', 'settings.json')
  let cur = {}
  try {
    cur = JSON.parse(fs.readFileSync(file, 'utf8'))
  } catch {
    /* absent or unparseable — a small file is what the app then reads */
  }
  const distill = cur.distill ?? {}
  const next = {
    ...cur,
    distill: {
      ...distill,
      pipeline: 'v3',
      attribution: { ...(distill.attribution ?? {}), default: true }
    }
  }
  fs.mkdirSync(path.dirname(file), { recursive: true })
  fs.writeFileSync(file, JSON.stringify(next, null, 2))
  return file
}

function readLangfuseConfig() {
  try {
    const cur = JSON.parse(fs.readFileSync(path.join(HOME, 'config', 'settings.json'), 'utf8'))
    const lf = cur.observability?.langfuse
    if (lf?.enabled && lf.host && lf.publicKey) return lf
  } catch {
    /* none */
  }
  return null
}

// ---------- the two assets, on disk ----------
/** User-tier skill (`<home>/skills-user/<name>/SKILL.md`) and shared reference
 *  (`<home>/references/<rel>`), so the inventory resolves a tier for each. */
function writeAssets() {
  const skillDir = path.join(HOME, 'skills-user', SKILL)
  fs.mkdirSync(skillDir, { recursive: true })
  fs.writeFileSync(
    path.join(skillDir, 'SKILL.md'),
    [
      '---',
      `name: ${SKILL}`,
      'description: Use when the telemetry uploader silently drops batches; checks chunk size against the gateway first-part limit.',
      '---',
      '',
      '# Diagnose uploader drops',
      '',
      '1. Compare the uploader chunk size with the gateway first-part limit (see nav/limits.md).',
      '2. Check how the client maps a 413 response — a silent non-retryable drop is the usual culprit.',
      '3. Check the staging config for flags that cap chunk size and mask the bug.',
      ''
    ].join('\n')
  )
  const refFile = path.join(HOME, 'references', ...REF.split('/'))
  fs.mkdirSync(path.dirname(refFile), { recursive: true })
  fs.writeFileSync(
    refFile,
    [
      '---',
      'title: Gateway limits',
      'trust_tier: team-knowledge',
      '---',
      '',
      '# Gateway limits',
      '',
      '- Multipart first-part limit: 3670016 bytes (3.5MiB). Larger first parts are rejected with HTTP 413.',
      '- Staging sets TELEMETRY_STRICT_SIZE=1 (2MB chunks); production leaves it unset.',
      ''
    ].join('\n')
  )
}

// ---------- seed transcript + finding (+ tool_calls) for a case the APP created ----------
function seedTranscript(slug, withTools) {
  const db = new DatabaseSync(DB)
  const now = new Date().toISOString()
  db.exec(`PRAGMA foreign_keys = ON;`)
  const c = db.prepare(`SELECT id FROM cases WHERE slug=?`).get(slug)
  if (!c) throw new Error(`case ${slug} not in DB — cases.create did not land`)
  const caseId = Number(c.id)
  const already = db.prepare(`SELECT COUNT(*) AS n FROM sessions WHERE case_id=?`).get(caseId)
  if (Number(already.n) > 0) {
    console.error(`transcript already seeded for ${slug} — reusing`)
    db.close()
    return caseId
  }
  const sess = (title) =>
    Number(
      db
        .prepare(
          `INSERT INTO sessions (case_id, driver_kind, title, turn_count, created_at, updated_at) VALUES (?, 'claude-agent-sdk', ?, 0, ?, ?)`
        )
        .run(caseId, title, now, now).lastInsertRowid
    )
  const s1 = sess('Initial triage')
  const s2 = sess('Root-cause confirmation')
  let turn = 1
  const msg = (sid, role, content) => {
    const rowid = Number(
      db
        .prepare(
          `INSERT INTO messages_fts (content, case_id, session_id, turn_id, role) VALUES (?, ?, ?, ?, ?)`
        )
        .run(content, caseId, sid, turn++, role).lastInsertRowid
    )
    db.prepare(
      `INSERT INTO messages_fts_map (fts_rowid, case_id, session_id) VALUES (?, ?, ?)`
    ).run(rowid, caseId, sid)
  }
  msg(
    s1,
    'user',
    'Uploader drops telemetry batches sometimes. Dig into it and tell me what you find; I will not repeat myself later, so write down the mechanism precisely.'
  )
  // The transcript names the skill and the reference in prose in EVERY fixture — including the
  // negative control. The negative control must still produce no attribution, because the
  // inventory is built from `tool_calls`, not from what the text says.
  msg(
    s1,
    'assistant',
    `I loaded the ${SKILL} skill and followed its first step, comparing chunk size against the gateway limit documented in the nav/limits.md reference. Found it. The uploader chunks at 4MB but the gateway rejects any multipart whose FIRST part exceeds 3.5MB with HTTP 413; the client swallows 413 as a retryable error and never retries because the retry budget is 0 for 4xx. Mechanism: chunk-size 4194304 vs gateway first-part limit 3670016 (3.5MiB), error class NonRetryable413 mapped to silent-drop in uploader/retry.py line 88.`
  )
  msg(
    s1,
    'user',
    'OK. And the second thing you found about the config flag — remind me next time exactly what it was, I did not write it down.'
  )
  msg(
    s1,
    'assistant',
    'The second finding: the flag TELEMETRY_STRICT_SIZE=1 in the staging config caps chunks at 2MB and masks the bug entirely, which is why staging never reproduced it; production has the flag unset. Removing the flag in staging reproduces the drop 100% of the time. The limits reference had the 3.5MiB figure, which is what pointed me at the first-part size.'
  )
  msg(
    s2,
    'user',
    'Bench confirmed both points from the earlier session. Root cause is the mechanism you described there — the exact chunk-vs-first-part numbers and the retry mapping. Please record it as the root cause using the precise values from that session, and capture the staging-flag gotcha as reusable knowledge — refer back to what you found, I am not restating the numbers.'
  )
  msg(
    s2,
    'assistant',
    'Recorded. Root cause per the earlier analysis; the staging-flag masking is the reusable gotcha.'
  )
  db.prepare(
    `INSERT INTO findings (case_id, session_id, summary, review_state, role, created_at)
     VALUES (?, ?, ?, 'accepted', 'root-cause', ?)`
  ).run(
    caseId,
    s2,
    'Uploader chunk size exceeds the gateway first-part limit; the resulting 413 is mapped to a silent non-retryable drop. Exact sizes and file/line are in the session transcript.',
    now
  )
  if (withTools) {
    // The two activations the inventory is built from (USAGE_PREDICATES: skill = `tool='Skill'`,
    // reference = `detail LIKE 'ref:%'`), both on the first session, both effective (decision 'auto').
    const tc = db.prepare(
      `INSERT INTO tool_calls (case_id, session_id, turn_id, tool, args_hash, detail, risk, decision, created_at)
       VALUES (?, ?, ?, ?, ?, ?, 'LOW', 'auto', ?)`
    )
    tc.run(caseId, s1, 1, 'Skill', 'live-gate-skill', SKILL, now)
    tc.run(caseId, s1, 2, 'Read', 'live-gate-ref', `ref:${REF}`, now)
  }
  db.close()
  return caseId
}

// ---------- DB reads ----------
const withDb = (fn) => {
  const db = new DatabaseSync(DB)
  try {
    return fn(db)
  } finally {
    db.close()
  }
}
const jobsFor = (slug) =>
  withDb((db) =>
    db
      .prepare(
        `SELECT id, kind, state, error, cost_usd, duration_ms, input_snapshot, stages_json FROM distill_jobs WHERE case_slug=? ORDER BY id`
      )
      .all(slug)
  )
const attributionRows = (slug) =>
  withDb((db) =>
    db
      .prepare(
        `SELECT a.* FROM asset_attributions a JOIN cases c ON c.id = a.case_id WHERE c.slug=? ORDER BY a.id`
      )
      .all(slug)
  )
const jsonOr = (text, fallback) => {
  try {
    return JSON.parse(text ?? '')
  } catch {
    return fallback
  }
}
const isTerminal = (j) => j.state === 'done' || j.state === 'failed' || j.state === 'cancelled'
const costOf = (slug) => jobsFor(slug).reduce((n, j) => n + (j.cost_usd ?? 0), 0)

/** Wait until the case has >= 1 job (when `expectJob`) and none queued/running, then a short
 *  settle so an escape-hatch enqueue triggered by the last job's finish has landed. */
async function settle(slug, expectJob) {
  const t0 = Date.now()
  if (expectJob) {
    await waitFor(`a job for ${slug}`, () => jobsFor(slug).length > 0, 30000)
  }
  await waitFor(
    `${slug} jobs terminal`,
    () => {
      const js = jobsFor(slug)
      return js.every(isTerminal) && (!expectJob || js.length > 0)
    },
    JOB_TIMEOUT_MS
  )
  await sleep(6000)
  await waitFor(
    `${slug} jobs terminal (after settle)`,
    () => jobsFor(slug).every(isTerminal),
    JOB_TIMEOUT_MS
  )
  console.error(`${slug}: terminal after ${Math.round((Date.now() - t0) / 1000)}s`)
}

// ---------- cite resolution ----------
/** `problems` lists every cite that does NOT resolve; `resolved` counts the ones that do — so a
 *  caller can tell "every cite resolved" from the vacuous "there were no cites to resolve". */
function citeCheck(rows, slug, snapshotsByJob) {
  const problems = []
  let resolved = 0
  const findingIds = withDb(
    (db) =>
      new Set(
        db
          .prepare(`SELECT f.id FROM findings f JOIN cases c ON c.id = f.case_id WHERE c.slug=?`)
          .all(slug)
          .map((r) => Number(r.id))
      )
  )
  for (const r of rows) {
    const cites = jsonOr(r.cites_json, null)
    if (!Array.isArray(cites)) {
      problems.push(`${r.asset_kind}/${r.asset_name}: cites_json not an array`)
      continue
    }
    const snap = snapshotsByJob.get(r.job_id)
    const turnCounts = new Map(
      (snap?.world?.sessions ?? []).map((s) => [Number(s.id), s.messages.length])
    )
    const evidencePaths = new Set((snap?.evidence ?? []).map((e) => e.relPath))
    for (const c of cites) {
      if (c && typeof c === 'object' && 'finding' in c) {
        if (!findingIds.has(Number(c.finding)))
          problems.push(`${r.asset_name}: finding ${c.finding} does not exist`)
        else resolved++
      } else if (c && typeof c === 'object' && 'evidence' in c) {
        if (!evidencePaths.has(c.evidence))
          problems.push(`${r.asset_name}: evidence ${c.evidence} not in the snapshot`)
        else resolved++
      } else if (c && typeof c === 'object' && 'session' in c) {
        const total = turnCounts.get(Number(c.session))
        if (total === undefined || !Number.isInteger(c.turn) || c.turn < 0 || c.turn >= total)
          problems.push(`${r.asset_name}: session ${c.session} turn ${c.turn} outside the world`)
        else resolved++
      } else {
        problems.push(`${r.asset_name}: unrecognised cite ${JSON.stringify(c)}`)
      }
    }
  }
  return { problems, resolved }
}

// ---------- UI helpers ----------
const clickByLabel = (conn, label) =>
  conn.evalJs(`(() => {
    const el = document.querySelector('[aria-label=${JSON.stringify(label)}]')
    if (!el) return false
    el.click()
    return true
  })()`)
const clickButtonText = (conn, text) =>
  conn.evalJs(`(() => {
    const el = [...document.querySelectorAll('button')].find((b) => (b.textContent || '').trim() === ${JSON.stringify(text)})
    if (!el) return false
    el.click()
    return true
  })()`)

// ---------- Langfuse read-back ----------
/** Returns the number of THIS run's asset.contribution scores, or `{ skipped: reason }`. Scoped
 *  twice so a previous run's scores can never satisfy it: the API query starts at the gate's own
 *  start time, and a score only counts when its metadata names one of the fixture slugs. */
async function langfuseScoreCount() {
  const lf = readLangfuseConfig()
  if (!lf) {
    console.error('langfuse: not configured, skipped')
    return { skipped: 'not configured' }
  }
  const secret = process.env.LANGFUSE_SECRET_KEY
  if (!secret) {
    console.error(
      'langfuse: configured, but LANGFUSE_SECRET_KEY not provided to the gate, skipped (the secret lives in the app keychain; the gate cannot read it)'
    )
    return { skipped: 'LANGFUSE_SECRET_KEY not provided' }
  }
  const auth = Buffer.from(`${lf.publicKey}:${secret}`).toString('base64')
  const fixtureSlugs = new Set(FIXTURES.map((f) => f.slug))
  const url = `${lf.host.replace(/\/+$/, '')}/api/public/scores?name=asset.contribution&limit=100&fromTimestamp=${encodeURIComponent(GATE_START_ISO)}`
  const deadline = Date.now() + 90_000
  let last = 0
  while (Date.now() < deadline) {
    try {
      const res = await fetch(url, { headers: { Authorization: `Basic ${auth}` } })
      if (res.ok) {
        const body = await res.json()
        const data = Array.isArray(body.data) ? body.data : []
        last = data.filter((sc) => fixtureSlugs.has(sc?.metadata?.['argus.case.slug'])).length
        if (last > 0) return last
      } else {
        console.error(`langfuse: scores API answered ${res.status}`)
      }
    } catch (e) {
      console.error(`langfuse: scores API unreachable (${String(e)})`)
    }
    await sleep(5000) // ingestion lags the export
  }
  return last
}

// ---------- CDP drive ----------
const main = async () => {
  const settingsFile = forceSettings()
  console.error(`settings forced (pipeline=v3, attribution.default=true) in ${settingsFile}`)
  writeAssets()

  const targets = await listTargets(PORT)
  const conn = await connect(mainWindow(targets))
  console.error(`connected to ${PORT}: ${targets.map((t) => t.url).join(', ')}`)

  // Create the cases through the app itself (DB row + on-disk case dir), unless they exist.
  const existing = (await conn.evalJs(`window.argus.cases.list()`)) ?? []
  for (const f of FIXTURES) {
    if (!existing.some((c) => c.slug === f.slug)) {
      await conn.evalJs(
        `window.argus.cases.create(${JSON.stringify({ slug: f.slug, title: `Attribution fixture ${f.slug}`, jiraKey: f.jiraKey })})`
      )
    }
    seedTranscript(f.slug, f.tools)
  }

  // Identity gate: this port must show OUR fixtures — created against OUR scratch home — not
  // another worktree's app (argus-cdp-port-collision).
  const cases = (await conn.evalJs(`window.argus.cases.list()`)) ?? []
  const missing = FIXTURES.filter((f) => !cases.some((c) => c.slug === f.slug))
  if (missing.length) {
    console.error(
      `IDENTITY FAIL: port ${PORT} does not show fixture case(s) ${missing.map((f) => f.slug).join(', ')}; refusing to continue`
    )
    process.exit(2)
  }
  // Not tautological: the app listing the slugs is not enough (another home could hold cases of
  // the same name) — each fixture must also be a row in THIS scratch home's DB, which is where
  // every assertion below reads from.
  const notInDb = withDb((db) =>
    FIXTURES.filter((f) => !db.prepare(`SELECT 1 FROM cases WHERE slug=?`).get(f.slug))
  )
  if (notInDb.length) {
    console.error(
      `IDENTITY FAIL: fixture case(s) ${notInDb.map((f) => f.slug).join(', ')} are not rows in ${DB}; the connected app is not using this ARGUS_HOME — refusing to continue`
    )
    process.exit(2)
  }
  check(
    'identity: all three fixture cases visible on the connected app AND present in ARGUS_HOME/argus.db',
    true
  )

  // Settings gate, BEFORE the money is spent: a v2 run has no attribution stage, and a default of
  // false would not matter to the preload call below but means the file edit did not land.
  const settings = await waitFor(
    'app reports distill.pipeline=v3 and attribution.default=true',
    async () => {
      const p = await conn.evalJs(`window.argus.settings.get()`)
      const d = p?.settings?.distill
      return d?.pipeline === 'v3' && d?.attribution?.default === true ? d : null
    },
    20000
  ).catch(() => null)
  if (!settings) {
    console.error(
      'SETTINGS FAIL: the app does not report v3 + attribution.default; refusing to spend'
    )
    process.exit(2)
  }
  check('app reports distill.pipeline=v3 and distill.attribution.default=true', true)

  for (const f of FIXTURES) {
    const before = jobsFor(f.slug)
    check(
      `${f.slug}: no prior distill jobs`,
      before.length === 0,
      before.map((j) => j.kind)
    )
  }

  const close = (slug, distill, attribution) =>
    conn.evalJs(
      `window.argus.cases.setStatus(${JSON.stringify(slug)}, 'closed', 'solved', ${distill}, ${attribution})`
    )

  // ---- case 1: positive ----
  await close(POSITIVE, true, true)
  await settle(POSITIVE, true)
  // ---- case 2: negative control ----
  await close(NEGATIVE, true, true)
  await settle(NEGATIVE, true)

  // ================= case 1 assertions =================
  {
    const jobs = jobsFor(POSITIVE)
    const caseJobs = jobs.filter((j) => j.kind === 'case')
    check(
      `${POSITIVE}: exactly one kind='case' job`,
      caseJobs.length === 1,
      jobs.map((j) => j.kind)
    )
    const job = caseJobs[0]
    check(`${POSITIVE}: case job reached done`, job?.state === 'done', {
      state: job?.state,
      error: job?.error
    })
    const stages = jsonOr(job?.stages_json, null)
    check(
      `${POSITIVE}: stages_json.attribution present`,
      Boolean(stages?.attribution),
      stages ? Object.keys(stages) : null
    )
    check(
      `${POSITIVE}: attribution stage has no error`,
      Boolean(stages?.attribution) && stages.attribution.error === undefined,
      stages?.attribution?.error
    )
    check(
      `${POSITIVE}: attribution was not skipped`,
      stages?.attributionSkipped === undefined,
      stages?.attributionSkipped
    )
    check(
      `${POSITIVE}: no escape-hatch attribution job (stage succeeded in-pipeline)`,
      jobs.every((j) => j.kind !== 'attribution'),
      jobs.map((j) => j.kind)
    )
    const snap = jsonOr(job?.input_snapshot, {})
    const inv = (snap.assets ?? []).map((a) => `${a.kind}/${a.name}`)
    check(
      `${POSITIVE}: snapshot inventory carries both assets`,
      inv.includes(`skill/${SKILL}`) && inv.includes(`reference/${REF}`),
      inv
    )
    check(
      `${POSITIVE}: inventory resolved the skill's tier`,
      (snap.assets ?? []).some((a) => a.kind === 'skill' && a.name === SKILL && a.tier),
      (snap.assets ?? []).map((a) => `${a.kind}/${a.name}:${a.tier}`)
    )

    const rows = attributionRows(POSITIVE)
    const skillRow = rows.find((r) => r.asset_kind === 'skill' && r.asset_name === SKILL)
    const refRow = rows.find((r) => r.asset_kind === 'reference' && r.asset_name === REF)
    check(`${POSITIVE}: asset_attributions row for skill/${SKILL}`, Boolean(skillRow))
    check(`${POSITIVE}: asset_attributions row for reference/${REF}`, Boolean(refRow))
    check(
      `${POSITIVE}: rows belong to the case job`,
      rows.length > 0 && rows.every((r) => r.job_id === job?.id),
      rows.map((r) => r.job_id)
    )
    check(
      `${POSITIVE}: case_domain is exactly LIVE (the Jira project of LIVE-81)`,
      rows.length > 0 && rows.every((r) => r.case_domain === 'LIVE'),
      [...new Set(rows.map((r) => r.case_domain))]
    )
    check(
      `${POSITIVE}: the reference row carries a non-null asset_tier (relPath-keyed tier lookup)`,
      Boolean(refRow?.asset_tier),
      refRow?.asset_tier
    )
    check(
      `${POSITIVE}: case_outcome stamped`,
      rows.length > 0 && rows.every((r) => typeof r.case_outcome === 'string' && r.case_outcome),
      [...new Set(rows.map((r) => r.case_outcome))]
    )
    check(
      `${POSITIVE}: prompt_hash + judge_model stamped on every row`,
      rows.length > 0 && rows.every((r) => /^[0-9a-f]{12}$/.test(r.prompt_hash) && r.judge_model),
      rows.map((r) => `${r.prompt_hash}/${r.judge_model}`)
    )
    check(
      `${POSITIVE}: every applied=1 row carries at least one cite`,
      rows.every((r) => r.applied !== 1 || (jsonOr(r.cites_json, []) ?? []).length > 0),
      rows.map(
        (r) => `${r.asset_name}:applied=${r.applied}:cites=${jsonOr(r.cites_json, []).length}`
      )
    )
    // Not vacuous: "every cite resolves" passes trivially when the judge applied nothing, so the
    // fixture (whose transcript follows the skill's first step) must yield an applied verdict and
    // at least one cite that actually resolved.
    check(
      `${POSITIVE}: ≥1 applied verdict for the skill fixture`,
      rows.some((r) => r.asset_kind === 'skill' && r.applied === 1),
      rows.map((r) => `${r.asset_kind}/${r.asset_name}:applied=${r.applied}`)
    )
    const { problems, resolved } = citeCheck(rows, POSITIVE, new Map([[job?.id, snap]]))
    check(`${POSITIVE}: ≥1 cite resolved`, resolved > 0, resolved)
    check(
      `${POSITIVE}: every cite resolves in the frozen snapshot`,
      problems.length === 0,
      problems
    )
    console.error(
      `${POSITIVE} verdicts: ${JSON.stringify(
        rows.map((r) => ({
          a: `${r.asset_kind}/${r.asset_name}`,
          applied: r.applied,
          verdict: r.verdict,
          reason: r.reason.slice(0, 140)
        })),
        null,
        2
      )}`
    )

    // --- UI: Observability → Knowledge usefulness, Library chip ---
    // Every navigation step waits for the DOM it needs (waitFor), never a fixed sleep: a slow
    // render must not read as a missing page, nor a fast one waste time.
    const settingsNavShown = () =>
      conn.evalJs(`Boolean(document.querySelector('nav[aria-label="Settings sections"]'))`)
    const clickSettingsSection = (name) =>
      conn.evalJs(`(() => {
      const nav = document.querySelector('nav[aria-label="Settings sections"]')
      const b = nav && [...nav.querySelectorAll('button')].find((x) => (x.textContent || '').trim() === ${JSON.stringify(name)})
      if (!b) return false
      b.click()
      return true
    })()`)
    await clickByLabel(conn, 'Settings')
    await waitFor('Settings sections nav', settingsNavShown, 10000).catch(() => null)
    const navOk = await clickSettingsSection('Observability')
    check('UI: Settings has an Observability page', navOk)
    const dashOk = await waitFor(
      'Open dashboard button',
      () => clickButtonText(conn, 'Open dashboard'),
      10000
    ).catch(() => false)
    check('UI: Observability page has an Open dashboard button', dashOk)
    const card = await waitFor(
      'Knowledge usefulness card',
      () =>
        conn.evalJs(
          `document.querySelector('[data-card-id="usefulness.assets"]')?.textContent || null`
        ),
      20000
    ).catch(() => null)
    check(
      'UI: Observability shows the Knowledge usefulness card',
      Boolean(card),
      card?.slice(0, 80)
    )
    check(
      'UI: the card lists both asset names',
      Boolean(card) && card.includes(SKILL) && card.includes(REF),
      card?.slice(0, 300)
    )

    // Back out of the dashboard (its close returns to Settings → Observability), then Library.
    // The dashboard's own Close button is the one sharing an ancestor with the card (the window
    // chrome has Close buttons of its own).
    await conn.evalJs(`(() => {
      let el = document.querySelector('[data-card-id="usefulness.assets"]')
      for (let i = 0; el && i < 12; i++, el = el.parentElement) {
        const b = el.querySelector('button[aria-label="Close"]')
        if (b) { b.click(); return true }
      }
      return false
    })()`)
    await waitFor(
      'dashboard closed',
      async () =>
        !(await conn.evalJs(
          `Boolean(document.querySelector('[data-card-id="usefulness.assets"]'))`
        )),
      10000
    ).catch(() => null)
    if (!(await settingsNavShown())) {
      await clickByLabel(conn, 'Settings')
      await waitFor('Settings sections nav', settingsNavShown, 10000).catch(() => null)
    }
    const libOk = await clickSettingsSection('Library')
    check('UI: Settings has a Library page', libOk)
    // The chip renders only for an asset the judge said was applied at least once; so what is
    // asserted is that the chip's presence tracks the DB, in both directions — and in BOTH
    // directions the skill's Library row must actually be on screen, or "no chip" proves nothing.
    const expectChip = rows.some((r) => r.asset_name === SKILL && r.applied === 1)
    const libraryScan = () =>
      conn.evalJs(`(() => {
      const re = /helped \\d+ · misled \\d+/gi
      const leaves = [...document.querySelectorAll('*')].filter(
        (e) => e.children.length === 0 && (e.textContent || '').trim() === ${JSON.stringify(SKILL)}
      )
      for (const leaf of leaves) {
        let el = leaf.parentElement
        for (let i = 0; el && i < 8; i++, el = el.parentElement) {
          const m = (el.textContent || '').match(re)
          if (m) {
            const t = el.textContent || ''
            if (m.length === 1 && !t.includes(${JSON.stringify(REF)}))
              return { rowFound: true, chipText: m[0] }
            break
          }
        }
      }
      return { rowFound: leaves.length > 0, chipText: null }
    })()`)
    // Wait for the row (and, when one is expected, its chip); on timeout keep the last scan.
    let lib = { rowFound: false, chipText: null }
    await waitFor(
      `Library row for ${SKILL}`,
      async () => {
        lib = (await libraryScan()) ?? lib
        return lib.rowFound && (!expectChip || lib.chipText)
      },
      15000
    ).catch(() => null)
    const { rowFound, chipText } = lib
    if (expectChip) {
      check(`UI: Library shows a row for ${SKILL}`, rowFound, lib)
      check(
        `UI: Library row for ${SKILL} carries a helped N · misled M chip`,
        /helped \d+ · misled \d+/i.test(chipText ?? ''),
        chipText
      )
    } else {
      check(`UI: Library shows a row for ${SKILL}`, rowFound, lib)
      check(
        `UI: Library row for ${SKILL} has NO chip (judge said it was not applied)`,
        rowFound && chipText === null,
        { chipText, applied: skillRow?.applied }
      )
    }
  }

  // ================= case 2 assertions (negative control) =================
  {
    const jobs = jobsFor(NEGATIVE)
    const job = jobs.find((j) => j.kind === 'case')
    check(`${NEGATIVE}: case job reached done`, job?.state === 'done', {
      state: job?.state,
      error: job?.error
    })
    const stages = jsonOr(job?.stages_json, null)
    check(
      `${NEGATIVE}: stages_json.attributionSkipped === 'no-assets'`,
      stages?.attributionSkipped === 'no-assets',
      stages?.attributionSkipped
    )
    check(`${NEGATIVE}: no attribution stage record`, stages?.attribution === undefined)
    check(
      `${NEGATIVE}: zero asset_attributions rows`,
      attributionRows(NEGATIVE).length === 0,
      attributionRows(NEGATIVE).length
    )
    check(
      `${NEGATIVE}: no kind='attribution' job`,
      jobs.every((j) => j.kind !== 'attribution'),
      jobs.map((j) => j.kind)
    )
  }

  // Spend guard — before the third (and last) run is paid for, AFTER the case 1/2 assertions
  // above have printed (so an abort still shows what the money already bought).
  const spent12 = costOf(POSITIVE) + costOf(NEGATIVE)
  console.error(`spend so far (cases 1+2): $${spent12.toFixed(2)}`)
  if (spent12 > SPEND_LIMIT_USD) {
    console.error(
      `SPEND ABORT: $${spent12.toFixed(2)} > $${SPEND_LIMIT_USD}; not closing ${NODISTILL}`
    )
    process.exit(2)
  }

  // ---- case 3: no distillation, attribution only ----
  await close(NODISTILL, false, true)
  await settle(NODISTILL, true)

  // ================= case 3 assertions (escape hatch) =================
  {
    const jobs = jobsFor(NODISTILL)
    check(
      `${NODISTILL}: NO kind='case' job`,
      jobs.every((j) => j.kind !== 'case'),
      jobs.map((j) => j.kind)
    )
    const att = jobs.filter((j) => j.kind === 'attribution')
    check(
      `${NODISTILL}: exactly one kind='attribution' job`,
      att.length === 1,
      jobs.map((j) => j.kind)
    )
    const job = att[0]
    check(`${NODISTILL}: attribution job reached done`, job?.state === 'done', {
      state: job?.state,
      error: job?.error
    })
    const stages = jsonOr(job?.stages_json, null)
    check(`${NODISTILL}: stages_json.dossier present (lite dossier ran)`, Boolean(stages?.dossier))
    check(
      `${NODISTILL}: stages_json.attribution present without error`,
      Boolean(stages?.attribution) && stages.attribution.error === undefined,
      stages?.attribution?.error
    )
    check(
      `${NODISTILL}: no summary / candidates / materialize stages (no proposals)`,
      !stages?.summary && !stages?.candidates && !(stages?.materialize ?? []).length,
      stages ? Object.keys(stages) : null
    )
    const rows = attributionRows(NODISTILL)
    check(
      `${NODISTILL}: asset_attributions rows exist for both assets`,
      rows.some((r) => r.asset_kind === 'skill' && r.asset_name === SKILL) &&
        rows.some((r) => r.asset_kind === 'reference' && r.asset_name === REF),
      rows.map((r) => `${r.asset_kind}/${r.asset_name}`)
    )
    const snap = jsonOr(job?.input_snapshot, {})
    const { problems, resolved } = citeCheck(rows, NODISTILL, new Map([[job?.id, snap]]))
    check(`${NODISTILL}: ≥1 cite resolved`, resolved > 0, resolved)
    check(
      `${NODISTILL}: every cite resolves in the frozen snapshot`,
      problems.length === 0,
      problems
    )
    console.error(
      `${NODISTILL} verdicts: ${JSON.stringify(rows.map((r) => ({ a: `${r.asset_kind}/${r.asset_name}`, applied: r.applied, verdict: r.verdict })))}`
    )

    // The runs view lists it with the `attribution only` label.
    const runs = (await conn.evalJs(`window.argus.distill.runsAll()`)) ?? []
    const mine = runs.filter((r) => r.caseSlug === NODISTILL)
    check(
      `${NODISTILL}: runsAll lists it as kind='attribution'`,
      mine.length === 1 && mine[0].kind === 'attribution',
      mine.map((r) => `${r.kind}:${r.state}`)
    )
    await clickByLabel(conn, 'Distillation runs')
    const label = await waitFor(
      'attribution only label in the runs rail',
      () =>
        conn.evalJs(
          `/attribution only/i.test(document.body.innerText) ? 'attribution only' : null`
        ),
      15000
    ).catch(() => null)
    check(
      'UI: the runs view shows the `attribution only` label',
      label === 'attribution only',
      label
    )
  }

  // ================= Langfuse =================
  const scores = await langfuseScoreCount()
  const langfuseSkipped = typeof scores === 'object' ? scores.skipped : null
  if (!langfuseSkipped) {
    check(
      'langfuse: asset.contribution scores from THIS run (fixture slugs, since gate start)',
      scores > 0,
      scores
    )
  }

  // ================= spend =================
  const total = [POSITIVE, NEGATIVE, NODISTILL].reduce((n, s) => n + costOf(s), 0)
  console.error(
    `total cost_usd across the three cases: $${total.toFixed(2)} (` +
      `${POSITIVE} $${costOf(POSITIVE).toFixed(2)}, ${NEGATIVE} $${costOf(NEGATIVE).toFixed(2)}, ${NODISTILL} $${costOf(NODISTILL).toFixed(2)})`
  )

  conn.close()
  // A skipped read-back records no assertion; say so right above the tally so "N/N passed" is
  // never read as "Langfuse verified".
  if (langfuseSkipped) console.error(`langfuse: skipped (${langfuseSkipped})`)
  report()
}

main().catch((e) => {
  console.error('GATE ERROR', e)
  process.exit(1)
})
