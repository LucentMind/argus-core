#!/usr/bin/env node
/**
 * Distillation v2 live gate — drives the REAL app over CDP against a scratch ARGUS_HOME.
 *
 * Proves what the fake seams cannot: a real agentic distill run (Claude SDK, MCP tools,
 * multi-turn), the recorded v2 columns, the staged proposal's basis frontmatter, and the
 * inbox rendering. Seeds its own fixture case + transcript into the app's DB before closing
 * the case with distill=true.
 *
 * Usage:
 *   1. ARGUS_HOME=<scratch> npx electron-vite dev --remoteDebuggingPort 9247
 *   2. ARGUS_HOME=<scratch> CDP_PORT=9247 node scripts/cdp-distill-v2.mjs
 *
 * Exits 0 when every check passes, 1 otherwise. Identity-gated: aborts unless the seeded
 * fixture case is what the app on that port actually shows (see argus-cdp-port-collision).
 */
import { DatabaseSync } from 'node:sqlite'
import path from 'node:path'
import { listTargets, connect, mainWindow, sleep, waitFor, check, report } from './lib/cdp.mjs'

const PORT = process.env.CDP_PORT || '9247'
const HOME = process.env.ARGUS_HOME
if (!HOME) {
  console.error('ARGUS_HOME is required (the scratch home the app was booted against)')
  process.exit(2)
}
const SLUG = 'live-v2-uploader-drop'
const DB = path.join(HOME, 'argus.db')

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

// ---------- CDP drive ----------
const main = async () => {
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

  // Poll to terminal — quality-first budgets mean this can legitimately take minutes.
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
  // 2026-08-17: a small case distilled in one turn with zero tool calls and a correct basis).
  // This fixture puts the decisive values ONLY in assistant turns and has the user say "refer
  // back, I am not restating" — so the tool path is required here and asserted; a run that
  // skips it on this fixture is a real regression.
  check(
    'turnCount recorded and > 1 (agentic, not one-shot)',
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
  check('promptChars recorded', (done.promptChars ?? 0) > 1000, done.promptChars)

  // DB-side truth: v2 columns + trajectory + snapshot world.
  const db = new DatabaseSync(DB)
  const row = db
    .prepare(
      `SELECT id, kind, state, input_tokens, output_tokens, cost_usd, duration_ms, prompt_chars, turn_count, tool_call_count, trajectory_json, dropped_json, item_count, prompt_hash, input_snapshot FROM distill_jobs WHERE case_slug=? ORDER BY id DESC LIMIT 1`
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
  check(
    'prompt_hash stamped (12 hex)',
    /^[0-9a-f]{12}$/.test(row.prompt_hash ?? ''),
    row.prompt_hash
  )
  console.error(`item_count=${row.item_count} dropped_json=${row.dropped_json}`)

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
