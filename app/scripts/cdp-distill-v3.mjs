#!/usr/bin/env node
/**
 * Distillation v3 live gate — drives the REAL app over CDP against a scratch ARGUS_HOME.
 *
 * The v2 gate's sibling (`cdp-distill-v2.mjs`), pointed at the staged pipeline: same fixture,
 * same identity gate, same real Claude SDK run, but with `settings.distill.pipeline = 'v3'` and
 * assertions on what only v3 produces — `stages_json` (dossier / summary / candidates /
 * materialize), per-stage prompt hashes, the job-level `prompt_hash` matching
 * `caseDistillPipelineHash()`, `evidence:` frontmatter on a staged proposal (v3's resolved
 * dossier cites), and a `cost_usd` strictly greater than the dossier stage's own cost — which is
 * the only thing that proves the four stages' usage is actually aggregated onto the row.
 *
 * Usage:
 *   1. ARGUS_HOME=<scratch> npx electron-vite dev --remoteDebuggingPort 9248
 *   2. ARGUS_HOME=<scratch> CDP_PORT=9248 node scripts/cdp-distill-v3.mjs
 *
 * The pipeline flag is written to <home>/config/settings.json by THIS script before it touches
 * the app, and re-read through the app's own settings IPC before the case is closed: the file is
 * watched, so a pre-boot write and a post-boot one both land, and a run that would have gone down
 * the v2 path aborts (exit 2) instead of spending ~$2 proving nothing.
 *
 * Exits 0 when every check passes, 1 otherwise. Identity-gated: aborts unless the seeded
 * fixture case is what the app on that port actually shows (see argus-cdp-port-collision).
 */
import { DatabaseSync } from 'node:sqlite'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { listTargets, connect, mainWindow, sleep, waitFor, check, report } from './lib/cdp.mjs'

const PORT = process.env.CDP_PORT || '9248'
const HOME = process.env.ARGUS_HOME
if (!HOME) {
  console.error('ARGUS_HOME is required (the scratch home the app was booted against)')
  process.exit(2)
}
const SLUG = 'live-v3-uploader-drop'
const DB = path.join(HOME, 'argus.db')
const APP_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')

// ---------- pipeline flag ----------
/**
 * Force `distill.pipeline = 'v3'` in the scratch home's settings file.
 *
 * Merged into whatever is there rather than written blind: `SettingsService` parses the file
 * against the schema and falls back to ALL defaults on a parse failure, so clobbering an existing
 * (valid) file would silently reset the rest of the home's settings — and the schema fills every
 * absent key anyway, which is why a one-key file is enough on a fresh home.
 */
function forceV3Setting() {
  const file = path.join(HOME, 'config', 'settings.json')
  let cur = {}
  try {
    cur = JSON.parse(fs.readFileSync(file, 'utf8'))
  } catch {
    /* absent or unparseable — a one-key file is what the app then reads */
  }
  const next = { ...cur, distill: { ...(cur.distill ?? {}), pipeline: 'v3' } }
  fs.mkdirSync(path.dirname(file), { recursive: true })
  fs.writeFileSync(file, JSON.stringify(next, null, 2))
  return file
}

// ---------- expected prompt hash ----------
/**
 * `caseDistillPipelineHash()` as the app would compute it, from the app's own TypeScript.
 *
 * Recomputing the digest here in JS would duplicate four contracts and every section header —
 * the two-representations defect this repo keeps re-learning — and the assertion would then pass
 * against a stale copy. There is no `tsx` in this tree, but `esbuild` is (vite pulls it in), and
 * `promptHash.ts`'s import graph is pure prompt text: no electron, no DB. So bundle it and import
 * the real function. Resolves against the DEFAULT prompt text, which equals what the app's
 * `resolvePrompt` returns while no dev prompt override is active — true on a scratch home.
 */
async function expectedPipelineHash() {
  const esbuild = await import('esbuild')
  const out = path.join(os.tmpdir(), `argus-v3-prompthash-${process.pid}.mjs`)
  await esbuild.build({
    entryPoints: [path.join(APP_DIR, 'src/main/services/distill/v3/promptHash.ts')],
    bundle: true,
    platform: 'node',
    format: 'esm',
    outfile: out,
    logLevel: 'error'
  })
  try {
    const m = await import(pathToFileURL(out).href)
    return {
      pipeline: m.caseDistillPipelineHash(),
      stages: Object.fromEntries(m.V3_STAGES.map((s) => [s, m.stagePromptHash(s)]))
    }
  } finally {
    try {
      fs.unlinkSync(out)
    } catch {
      /* best effort */
    }
  }
}

// ---------- seed transcript + finding into the app's DB for a case the APP created ----------
// The case row itself is created through the app's own IPC (cases.create) so the on-disk
// case dir / case.json exist — setStatus needs them. Only sessions/messages/finding are
// injected here, against the id the app assigned.
function seedTranscript() {
  const db = new DatabaseSync(DB)
  const now = new Date().toISOString()
  db.exec(`PRAGMA foreign_keys = ON;`)
  const c = db.prepare(`SELECT id FROM cases WHERE slug=?`).get(SLUG)
  if (!c) throw new Error(`case ${SLUG} not in DB — cases.create did not land`)
  const caseId = Number(c.id)
  const already = db.prepare(`SELECT COUNT(*) AS n FROM sessions WHERE case_id=?`).get(caseId)
  if (Number(already.n) > 0) {
    console.error(`transcript already seeded for ${SLUG} — reusing`)
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
  const s1 = sess('Initial triage of LIVE-77')
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
  msg(
    s1,
    'assistant',
    'Found it. The uploader chunks at 4MB but the gateway rejects any multipart whose FIRST part exceeds 3.5MB with HTTP 413; the client swallows 413 as a retryable error and never retries because the retry budget is 0 for 4xx. Mechanism: chunk-size 4194304 vs gateway first-part limit 3670016 (3.5MiB), error class NonRetryable413 mapped to silent-drop in uploader/retry.py line 88.'
  )
  msg(
    s1,
    'user',
    'OK. And the second thing you found about the config flag — remind me next time exactly what it was, I did not write it down.'
  )
  msg(
    s1,
    'assistant',
    'The second finding: the flag TELEMETRY_STRICT_SIZE=1 in the staging config caps chunks at 2MB and masks the bug entirely, which is why staging never reproduced it; production has the flag unset. Removing the flag in staging reproduces the drop 100% of the time.'
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
  // Finding bodies live in <case>/findings.md (parsed by id), not in the DB — a DB-only seed
  // puts the detail into the summary so the distiller still sees a rich root-cause finding.
  db.prepare(
    `INSERT INTO findings (case_id, session_id, summary, review_state, role, created_at)
     VALUES (?, ?, ?, 'accepted', 'root-cause', ?)`
  ).run(
    caseId,
    s2,
    'Uploader chunk size exceeds the gateway first-part limit; the resulting 413 is mapped to a silent non-retryable drop. Exact sizes and file/line are in the session transcript.',
    now
  )
  db.close()
  return caseId
}

/** Frontmatter block of every pending proposal file staged for our fixture case. */
function proposalFrontmatter() {
  const dir = path.join(HOME, 'proposals')
  if (!fs.existsSync(dir)) return []
  return fs
    .readdirSync(dir, { withFileTypes: true })
    .filter((e) => e.isFile() && e.name.endsWith('.md'))
    .map((e) => {
      const text = fs.readFileSync(path.join(dir, e.name), 'utf8')
      const m = /^---\r?\n([\s\S]*?)\r?\n---\r?\n/.exec(text)
      return { file: e.name, fm: m ? m[1] : '' }
    })
    .filter((p) => new RegExp(`^case: ${SLUG}$`, 'm').test(p.fm))
}

const HEX12 = /^[0-9a-f]{12}$/

// ---------- CDP drive ----------
const main = async () => {
  const settingsFile = forceV3Setting()
  console.error(`pipeline flag written to ${settingsFile}`)
  const expected = await expectedPipelineHash()
  console.error(`expected hashes: ${JSON.stringify(expected)}`)

  const targets = await listTargets(PORT)
  const conn = await connect(mainWindow(targets))
  console.error(`connected to ${PORT}: ${targets.map((t) => t.url).join(', ')}`)

  // Create the case through the app itself (DB row + on-disk case dir), unless it exists.
  const existingCases = await conn.evalJs(`window.argus.cases.list()`)
  if (!(existingCases ?? []).some((c) => c.slug === SLUG)) {
    await conn.evalJs(
      `window.argus.cases.create(${JSON.stringify({ slug: SLUG, title: 'Telemetry uploader silently drops batches over 4MB', jiraKey: 'LIVE-77' })})`
    )
  }
  seedTranscript()

  // Identity gate: this port must show OUR fixture — created against OUR scratch home — not
  // another worktree's app. The scratch DB having the row proves nothing about which app the
  // port serves; the app's own list must agree.
  const cases = await conn.evalJs(`window.argus.cases.list()`)
  const mine = (cases ?? []).find((c) => c.slug === SLUG)
  if (!mine) {
    console.error(
      `IDENTITY FAIL: port ${PORT} does not show fixture case ${SLUG}; refusing to continue`
    )
    process.exit(2)
  }
  check('identity: fixture case visible on the connected app', true, mine.title)

  // Pipeline gate, BEFORE the money is spent: settings.json is watched, so a write made after
  // boot still reaches the running app — but only once the watcher fires. A v2 reading here is
  // not a failed assertion, it is a run that must not happen.
  const pipeline = await waitFor(
    'app reports distill.pipeline=v3',
    async () => {
      const p = await conn.evalJs(`window.argus.settings.get()`)
      return p?.settings?.distill?.pipeline === 'v3' ? 'v3' : null
    },
    20000
  ).catch(() => null)
  if (pipeline !== 'v3') {
    console.error('PIPELINE FAIL: the app does not report distill.pipeline=v3; refusing to spend')
    process.exit(2)
  }
  check('app reports distill.pipeline=v3', true, pipeline)

  // Kick a real distill: close solved with distill=true.
  const before = await conn.evalJs(`window.argus.distill.status(${JSON.stringify(SLUG)})`)
  check('no prior distill job for the fixture', before === null, before)
  await conn.evalJs(
    `window.argus.cases.setStatus(${JSON.stringify(SLUG)}, 'closed', 'solved', true)`
  )
  const job0 = await waitFor(
    'distill job enqueued',
    () => conn.evalJs(`window.argus.distill.status(${JSON.stringify(SLUG)})`),
    15000
  )
  check('job enqueued after close', Boolean(job0) && job0.caseSlug === SLUG, job0)

  // Poll to terminal — four stages, one of them agentic, so this legitimately takes minutes.
  const t0 = Date.now()
  const done = await waitFor(
    'distill job terminal',
    async () => {
      const j = await conn.evalJs(`window.argus.distill.status(${JSON.stringify(SLUG)})`)
      if (j && (j.state === 'done' || j.state === 'failed' || j.state === 'cancelled')) return j
      return null
    },
    25 * 60 * 1000
  )
  console.error(`terminal after ${Math.round((Date.now() - t0) / 1000)}s: ${JSON.stringify(done)}`)
  check('job reached done (not failed/cancelled)', done.state === 'done', {
    state: done.state,
    error: done.error
  })
  // Whether the model NEEDS the tools is a property of the fixture, not the seam (learned live
  // 2026-08-17 on the v2 gate: a small case distilled in one turn with zero tool calls and a
  // correct basis). This fixture puts the decisive values ONLY in assistant turns and has the
  // user say "refer back, I am not restating" — so the dossier stage must reach for the world
  // tools, and a run that skips them on this fixture is a real regression. The counts on a v3
  // row come from the dossier stage alone; the later stages are tool-less by construction.
  check(
    'turnCount recorded and > 1 (agentic dossier, not one-shot)',
    (done.turnCount ?? 0) > 1,
    done.turnCount
  )
  check(
    'toolCallCount recorded (>= 1 tool call)',
    (done.toolCallCount ?? 0) >= 1,
    done.toolCallCount
  )
  check(
    'costUsd recorded (non-null)',
    done.costUsd !== null && done.costUsd !== undefined,
    done.costUsd
  )
  // Sum of four stage prompts, not one — comfortably past v2's own floor.
  check('promptChars recorded', (done.promptChars ?? 0) > 1000, done.promptChars)

  // DB-side truth: the shared columns, then everything v3-only.
  const db = new DatabaseSync(DB)
  const row = db
    .prepare(
      `SELECT id, kind, state, input_tokens, output_tokens, cost_usd, duration_ms, prompt_chars, turn_count, tool_call_count, trajectory_json, dropped_json, item_count, prompt_hash, input_snapshot, stages_json FROM distill_jobs WHERE case_slug=? ORDER BY id DESC LIMIT 1`
    )
    .get(SLUG)
  db.close()
  check('row kind=case', row.kind === 'case', row.kind)
  check(
    'input_tokens/output_tokens non-null',
    row.input_tokens !== null && row.output_tokens !== null,
    {
      i: row.input_tokens,
      o: row.output_tokens
    }
  )
  check('duration_ms recorded', (row.duration_ms ?? 0) > 0, row.duration_ms)
  let traj = []
  try {
    traj = JSON.parse(row.trajectory_json ?? '[]')
  } catch {
    traj = [{ tool: 'UNPARSEABLE', raw: String(row.trajectory_json).slice(0, 80) }]
  }
  check(
    'trajectory_json parses with >= 1 entry naming an mcp__argus__ tool',
    traj.length >= 1 && traj.every((t) => String(t.tool).startsWith('mcp__argus__')),
    traj.slice(0, 5)
  )
  const snap = JSON.parse(row.input_snapshot)
  check(
    'input_snapshot carries world with 2 sessions',
    snap.world?.sessions?.length === 2,
    snap.world?.sessions?.map((s) => s.title)
  )
  check(
    'input_snapshot carries userMessages',
    Array.isArray(snap.userMessages) && snap.userMessages.length >= 1,
    snap.userMessages?.length
  )
  check('prompt_hash stamped (12 hex)', HEX12.test(row.prompt_hash ?? ''), row.prompt_hash)
  // The v3 flag was set before enqueue, so the row must carry the PIPELINE hash (all four stage
  // prompts), not v2's single-prompt hash. Equality against the app's own function is what makes
  // this an assertion rather than a shape check.
  check('prompt_hash equals caseDistillPipelineHash()', row.prompt_hash === expected.pipeline, {
    row: row.prompt_hash,
    expected: expected.pipeline
  })
  console.error(`item_count=${row.item_count} dropped_json=${row.dropped_json}`)

  // ---- v3: the staged pipeline's own record ----
  check('stages_json non-null (this is a v3 row)', row.stages_json !== null, typeof row.stages_json)
  let stages = null
  try {
    stages = JSON.parse(row.stages_json ?? 'null')
  } catch (e) {
    check('stages_json parses', false, String(e))
  }
  const stageSummary = stages
    ? {
        keys: Object.keys(stages),
        dossier: {
          promptHash: stages.dossier?.promptHash,
          promptChars: stages.dossier?.promptChars,
          rawChars: stages.dossier?.rawOutput?.length,
          usage: stages.dossier?.usage,
          error: stages.dossier?.error
        },
        summary: {
          promptHash: stages.summary?.promptHash,
          promptChars: stages.summary?.promptChars,
          usage: stages.summary?.usage,
          error: stages.summary?.error
        },
        candidates: {
          promptHash: stages.candidates?.promptHash,
          promptChars: stages.candidates?.promptChars,
          usage: stages.candidates?.usage,
          error: stages.candidates?.error
        },
        materialize: (stages.materialize ?? []).map((m) => ({
          type: m.type,
          target: m.target,
          promptHash: m.promptHash,
          usage: m.usage,
          error: m.error,
          flags: m.flags
        }))
      }
    : null
  console.error(`stages_json shape: ${JSON.stringify(stageSummary, null, 2)}`)
  check(
    'stages_json carries dossier + summary + candidates records',
    Boolean(stages?.dossier && stages?.summary && stages?.candidates),
    stages ? Object.keys(stages) : null
  )
  check(
    'stages_json.materialize is an array with >= 1 record (a candidate survived veto)',
    Array.isArray(stages?.materialize) && stages.materialize.length >= 1,
    stages?.materialize?.length
  )
  const stageRecords = stages
    ? [
        ['dossier', stages.dossier],
        ['summary', stages.summary],
        ['candidates', stages.candidates],
        ...(stages.materialize ?? []).map((m, i) => [`materialize[${i}]`, m])
      ].filter(([, r]) => r)
    : []
  check(
    'every stage record carries a 12-hex promptHash',
    stageRecords.length >= 4 && stageRecords.every(([, r]) => HEX12.test(r.promptHash ?? '')),
    stageRecords.map(([n, r]) => `${n}=${r.promptHash}`)
  )
  // Each record's hash must be its OWN stage's hash — a single shared constant would satisfy the
  // regex above while telling a replay nothing about which prompt produced which stage.
  check(
    'each stage promptHash matches the expected hash for that stage',
    // `.every` on an empty list is vacuously true — an absent stages_json must fail this check,
    // not sail through it (same guard as the hex check above).
    stageRecords.length >= 4 &&
      stageRecords.every(([n, r]) => r.promptHash === expected.stages[n.replace(/\[\d+\]$/, '')]),
    expected.stages
  )
  const dossierCost = stages?.dossier?.usage?.costUsd
  check(
    'cost_usd aggregates past the dossier stage alone',
    typeof dossierCost === 'number' &&
      typeof row.cost_usd === 'number' &&
      row.cost_usd > dossierCost,
    { row: row.cost_usd, dossier: dossierCost }
  )

  // Proposals: at least a case-summary or a proposal staged, with basis on non-summary items.
  const payload = await conn.evalJs(`window.argus.proposals.list()`)
  const props = (payload?.proposals ?? []).filter((p) => p.caseSlug === SLUG)
  check(
    'staging produced >= 1 proposal for the case',
    props.length >= 1,
    props.map((p) => `${p.type}:${p.target}`)
  )
  const nonSummary = props.filter((p) => p.type !== 'case-summary')
  if (nonSummary.length) {
    check(
      'every non-summary proposal carries a basis (>= 20 chars)',
      nonSummary.every((p) => (p.basis ?? '').length >= 20),
      nonSummary.map((p) => p.basis)
    )
  } else {
    check(
      'non-summary proposals present (soft: distiller may legitimately emit summary only)',
      false,
      'summary-only run'
    )
  }
  // v3-only frontmatter: the resolved dossier cites a reviewer can trace the claim back to.
  // Read off disk rather than through `proposals.list()` — `evidence` is not on ProposalRecord,
  // so the IPC payload cannot see it and a check built there would be vacuous.
  const fms = proposalFrontmatter()
  const withEvidence = fms.filter((p) => /^evidence: .+$/m.test(p.fm))
  check(
    '>= 1 staged proposal file carries an evidence: frontmatter line',
    withEvidence.length >= 1,
    fms.map((p) => `${p.file}: ${/^evidence: (.*)$/m.exec(p.fm)?.[1]?.slice(0, 120) ?? '(none)'}`)
  )

  // Inbox render, driven through the app's own controls (learned live 2026-08-17): the nav is
  // [aria-label="Proposals"] and each row is a button labelled "Select proposal <title>".
  await conn.evalJs(
    `(() => { const el = document.querySelector('[aria-label="Proposals"]'); if (el) el.click(); return Boolean(el) })()`
  )
  await sleep(1200)
  if (nonSummary.length) {
    const label = 'Select proposal ' + nonSummary[0].title
    const clicked = await conn.evalJs(`(() => {
      const el = [...document.querySelectorAll('button')].find((b) => (b.getAttribute('aria-label') || '') === ${JSON.stringify(label)})
      if (!el) return false
      el.click()
      return true
    })()`)
    check('inbox row for the proposal is clickable', clicked, label.slice(0, 80))
    await sleep(900)
    const bodyText = await conn.evalJs(`document.body.innerText`)
    check(
      'detail pane renders the basis text',
      bodyText.includes('Basis:'),
      bodyText.includes('Basis:')
    )
  }

  conn.close()
  report()
}

main().catch((e) => {
  console.error('GATE ERROR', e)
  process.exit(1)
})
