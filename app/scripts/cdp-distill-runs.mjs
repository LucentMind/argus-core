#!/usr/bin/env node
/**
 * Distillation Runs view live gate — drives the REAL app over CDP against a scratch ARGUS_HOME.
 *
 * The sibling of `cdp-distill-v3.mjs`: same fixture, same identity gate, same pipeline gate, same
 * real Claude SDK run started by closing the case solved-with-distill. Where the v3 gate stops at
 * the DB row, this one keeps going through the surface the 2026-09-04 spec added — the cross-case
 * Distillation Runs view — and asserts the things jsdom structurally cannot see:
 *
 *   1. the dev-only TopBar button actually opens the view in the real renderer
 *   2. a REAL run seeded by close-with-distill shows up as a rail row with a rendered strip and a
 *      structured dossier card carrying resolved cite chips
 *   3. "New run…" starts a DRY run from the view, against a case picked through the search
 *   4. `distill:progress` reaches the renderer live: >= 3 distinct phases for that job, a
 *      `materialize` tick naming its target, a `dossier` tick with a world-tool count, and NO
 *      `staging` phase (a dry run returns before the queue's staging step)
 *   5. the dry row auto-selects, its `staged` strip node reads "not staged (dry run)"
 *   6. compare puts the dry run and the real run in two columns
 *   7. Observability's Distillation card group reports a non-zero dry-run spend and offers the
 *      dev-only "Open runs" jump
 *   8. Settings → Agent no longer carries the spend row that group replaced
 *
 * Two runs are spent: ONE real (~$2-3, minutes) and ONE dry.
 *
 * Usage:
 *   1. ARGUS_HOME=<scratch> npx electron-vite dev --remoteDebuggingPort 9249
 *   2. ARGUS_HOME=<scratch> CDP_PORT=9249 node scripts/cdp-distill-runs.mjs
 *
 * Exits 0 when every check passes, 1 otherwise. Identity-gated: aborts (exit 2) unless the seeded
 * fixture case is what the app on that port actually shows (see argus-cdp-port-collision), and
 * pipeline-gated: aborts rather than spending money on a v2 run that would prove nothing about
 * the staged strip.
 */
import { DatabaseSync } from 'node:sqlite'
import fs from 'node:fs'
import path from 'node:path'
import { listTargets, connect, mainWindow, sleep, waitFor, check, report } from './lib/cdp.mjs'

const PORT = process.env.CDP_PORT || '9249'
const HOME = process.env.ARGUS_HOME
if (!HOME) {
  console.error('ARGUS_HOME is required (the scratch home the app was booted against)')
  process.exit(2)
}
const SLUG = 'live-runs-uploader-drop'
const DB = path.join(HOME, 'argus.db')

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

const TERMINAL = ['done', 'failed', 'cancelled']
/** Text meaning "no usable model login", not "the pipeline is broken". */
const AUTH_ERROR = /failed to authenticate|oauth session|not logged in|invalid api key|401|403/i

/**
 * Did job `id` die because the provider could not authenticate?
 *
 * NOT readable from the job's own `error`: a driver that fails to authenticate still returns —
 * with the auth message as its OUTPUT — so the pipeline's parser is what fails, and the row's
 * error is the downstream `dossier: invalid JSON: expected exactly 1 json fence, got 0`. The
 * provider's actual complaint only survives in `raw_output` / the dossier stage's `rawOutput`.
 */
function authFailure(id) {
  const db = new DatabaseSync(DB)
  const r = db.prepare(`SELECT error, raw_output, stages_json FROM distill_jobs WHERE id=?`).get(id)
  db.close()
  if (!r) return null
  const hay = `${r.error ?? ''}\n${r.raw_output ?? ''}\n${r.stages_json ?? ''}`
  const m = /[^\n"]*(?:failed to authenticate|oauth session)[^\n"]*/i.exec(hay)
  return AUTH_ERROR.test(hay) ? (m?.[0] ?? 'provider authentication failed') : null
}

// ---------- renderer helpers ----------
/**
 * Set a React-controlled input/select/textarea's value the way a user would.
 *
 * A plain `el.value = x` mutates the DOM but leaves React's internal `_valueTracker` holding the
 * SAME string it just wrote, so the synthetic change event is suppressed as a no-op and the
 * component's state never moves — the case picker silently lists nothing. Going through the
 * prototype's own setter is what makes the tracker see a change (the idiom `cdp-rca-editing.mjs`
 * already uses for textareas).
 */
const setReactValue = (conn, selector, value, proto = 'HTMLInputElement') =>
  conn.evalJs(`(() => {
    const el = document.querySelector(${JSON.stringify(selector)})
    if (!el) return false
    const setter = Object.getOwnPropertyDescriptor(window.${proto}.prototype, 'value').set
    setter.call(el, ${JSON.stringify(value)})
    el.dispatchEvent(new Event('input', { bubbles: true }))
    el.dispatchEvent(new Event('change', { bubbles: true }))
    return true
  })()`)

/** Click the first button whose trimmed text equals `text`. Returns false when there is none. */
const clickButtonByText = (conn, text) =>
  conn.evalJs(`(() => {
    const b = [...document.querySelectorAll('button')]
      .find((x) => x.textContent.trim() === ${JSON.stringify(text)})
    if (!b) return false
    b.click()
    return true
  })()`)

/** `[aria-label="…"]`, quoted in NODE rather than assembled in the page: an apostrophe in the
 *  label (the dry-run checkbox has one) survives `JSON.stringify` and breaks nothing. */
const byLabel = (label) => `[aria-label=${JSON.stringify(label)}]`

const clickByLabel = (conn, label) =>
  conn.evalJs(`(() => {
    const el = document.querySelector(${JSON.stringify(byLabel(label))})
    if (!el) return false
    el.click()
    return true
  })()`)

/** A fresh ARGUS_HOME opens the first-run wizard over everything; dismiss it once. */
const skipOnboarding = async (conn) => {
  await conn.evalJs(`(() => {
    const b = [...document.querySelectorAll('button')].find((x) => x.textContent.trim() === 'Skip setup')
    if (b) b.click()
    return Boolean(b)
  })()`)
  await sleep(500)
}

/**
 * Open Settings on `label`. The top-bar gear TOGGLES the view, so it is clicked only when the
 * rail is not already on screen — clicking it unconditionally shuts Settings again on the second
 * page and makes the next assertion fail for the wrong reason (learned in cdp-settings-cleanup).
 */
const openSettingsPage = async (conn, label) => {
  const navExists = () =>
    conn.evalJs(`(() => Boolean([...document.querySelectorAll('button')].find(
      (x) => x.textContent.trim() === ${JSON.stringify(label)}
    )))()`)
  if (!(await navExists())) {
    await clickByLabel(conn, 'Settings')
    await sleep(600)
  }
  await waitFor(`the ${label} settings nav entry`, () => clickButtonByText(conn, label))
  await sleep(600)
}

// ---------- CDP drive ----------
const main = async () => {
  const t00 = Date.now()
  const settingsFile = forceV3Setting()
  console.error(`pipeline flag written to ${settingsFile}`)

  const targets = await waitFor(
    'a page target',
    async () => {
      const t = await listTargets(PORT).catch(() => [])
      return t.length > 0 ? t : null
    },
    120000
  )
  const conn = await connect(mainWindow(targets) ?? targets[0])
  console.error(`connected to ${PORT}: ${targets.map((t) => t.url).join(', ')}`)
  await waitFor('the app shell', () => conn.evalJs(`Boolean(document.querySelector('body *'))`))
  await skipOnboarding(conn)

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
  const reportsV3 = async () => {
    const p = await conn.evalJs(`window.argus.settings.get()`)
    return p?.settings?.distill?.pipeline === 'v3' ? 'v3' : null
  }
  let pipeline = await waitFor('app reports distill.pipeline=v3', reportsV3, 8000).catch(() => null)
  if (pipeline !== 'v3') {
    // The file write alone is not enough on a genuinely fresh home: `config/settings.json` does
    // not exist at boot, so the watcher is watching a path that never gets a *change* event — it
    // gets a *create*, which is how this gate first presented ("PIPELINE FAIL" on home #2 while
    // home #1, whose file already existed, flipped fine). Push the same value through the app's
    // own settings IPC, which is what a user toggling the pipeline select would do.
    console.error('settings watcher did not pick the file up; patching through settings IPC')
    await conn.evalJs(`window.argus.settings.patch({ distill: { pipeline: 'v3' } })`)
    pipeline = await waitFor('app reports distill.pipeline=v3 after patch', reportsV3, 15000).catch(
      () => null
    )
  }
  if (pipeline !== 'v3') {
    console.error('PIPELINE FAIL: the app does not report distill.pipeline=v3; refusing to spend')
    process.exit(2)
  }
  check('app reports distill.pipeline=v3', true, pipeline)

  // ── the REAL run, seeded exactly as the v3 gate does (close solved + distill) ─────────────
  const before = await conn.evalJs(`window.argus.distill.status(${JSON.stringify(SLUG)})`)
  check('no prior distill job for the fixture', before === null, before)
  await conn.evalJs(
    `window.argus.cases.setStatus(${JSON.stringify(SLUG)}, 'closed', 'solved', true)`
  )
  const realJob = await waitFor(
    'real distill job enqueued',
    () => conn.evalJs(`window.argus.distill.status(${JSON.stringify(SLUG)})`),
    15000
  )
  check('real run enqueued by close-with-distill', realJob.caseSlug === SLUG, realJob)
  const t0 = Date.now()
  const realDone = await waitFor(
    'real distill job terminal',
    async () => {
      const j = await conn.evalJs(`window.argus.distill.status(${JSON.stringify(SLUG)})`)
      return j && TERMINAL.includes(j.state) ? j : null
    },
    25 * 60 * 1000
  )
  console.error(
    `real run terminal after ${Math.round((Date.now() - t0) / 1000)}s: ${JSON.stringify(realDone)}`
  )
  // Auth gate, the third of the same family as identity and pipeline: a run that failed because
  // the machine has no usable model login is not a failed assertion about this view, it is a gate
  // that never got to run. Left ungated it costs nothing (the run dies in ~1s) but it makes every
  // downstream check — progress phases, cite chips, spend cards — fail for a reason that has
  // nothing to do with them, which is exactly the "vacuous live assertion" trap in reverse. Exit
  // 2 (environment not ready), not 1 (a check failed), and say what to do about it.
  const authFailed = realDone.state === 'failed' ? authFailure(realDone.id) : null
  if (authFailed) {
    console.error(
      `AUTH FAIL: the distill provider could not authenticate — ${authFailed}\n` +
        `(the row's own error is the downstream parse failure: ${realDone.error})\n` +
        `The gate needs a working model login for the configured distill provider (a Claude\n` +
        `login by default). Log in, then re-run; nothing was spent (cost_usd=${realDone.costUsd}).`
    )
    process.exit(2)
  }
  check('real run reached done', realDone.state === 'done', {
    state: realDone.state,
    error: realDone.error
  })

  // ── open the view from the TopBar (dev boot ⇒ dev tools on ⇒ the button exists) ───────────
  const opened = await clickByLabel(conn, 'Distillation runs')
  check('TopBar carries the dev-only Distillation runs button', opened)
  await waitFor('runs view mounted', () =>
    conn.evalJs(
      `[...document.querySelectorAll('h1')].some((h) => h.textContent.includes('Distillation runs')) || null`
    )
  )
  check('runs view opened from the TopBar', true)

  // The real run is the newest row, so the view auto-selects it: rail row, strip, dossier card.
  await waitFor('the real run selected', () =>
    conn.evalJs(`document.querySelector('[data-testid="strip-dossier"]') ? true : null`)
  )
  const realSurface = await conn.evalJs(`(() => ({
    rows: document.querySelectorAll('[data-testid="run-row"]').length,
    rowLabels: [...document.querySelectorAll('[data-testid="run-row"]')].map((b) => b.textContent.trim()),
    stagedStat: document.querySelector('[data-testid="strip-staged"]')?.textContent ?? null,
    dossierState: document.querySelector('[data-testid="strip-dossier"]')?.dataset.state ?? null,
    dossierCard: document.querySelector('[data-testid="card-dossier"]')?.textContent ?? null
  }))()`)
  check(
    'the real run shows as a rail row naming its id',
    realSurface.rows >= 1 && realSurface.rowLabels.some((l) => l.includes(`#${realDone.id}`)),
    realSurface.rowLabels
  )
  check(
    'the real run strip shows a done dossier node',
    realSurface.dossierState === 'done',
    realSurface.dossierState
  )
  check(
    'the real run staged node reports what staging produced',
    /\d+ staged/.test(realSurface.stagedStat ?? ''),
    realSurface.stagedStat
  )
  check(
    'the real run renders a structured dossier card',
    (realSurface.dossierCard ?? '').includes('root cause'),
    (realSurface.dossierCard ?? '').slice(0, 200)
  )

  // ── a renderer-side collector for progress broadcasts, installed BEFORE the dry run ───────
  // Installed here (not before the real run) and still filtered by job id below: the real run's
  // own `staging` tick would otherwise sit in the array and make "no staging phase on a dry run"
  // fail for a reason that has nothing to do with the dry path.
  await conn.evalJs(
    `window.__argusProgress = []; window.argus.distill.onProgress((p) => window.__argusProgress.push(p))`
  )

  // ── New run… → pick our case through the search → Dry → Start ─────────────────────────────
  check('the rail offers New run…', await clickButtonByText(conn, 'New run…'))
  await waitFor('the new-run dialog', () =>
    conn.evalJs(
      `document.querySelector('[role="dialog"][aria-label="New distillation run"]') ? true : null`
    )
  )
  await setReactValue(conn, 'input[aria-label="Case"]', SLUG)
  await waitFor('a case option', () =>
    conn.evalJs(`document.querySelector('[role="option"]') ? true : null`)
  )
  check(
    'the case search finds the fixture',
    await conn.evalJs(
      `document.querySelector('[role="option"]').textContent.includes(${JSON.stringify('LIVE-77')})`
    )
  )
  await conn.evalJs(`document.querySelector('[role="option"]').click()`)
  await sleep(300)
  await conn.evalJs(`document.querySelector('input[aria-label="Dry run"]').click()`)
  await sleep(300)
  check(
    'a dry run defaults to ignoring the prior proposals',
    await conn.evalJs(
      `(() => { const el = document.querySelector(${JSON.stringify(byLabel("Ignore this case's prior proposals"))}); return Boolean(el) && el.checked })()`
    )
  )
  check('Start is offered', await clickButtonByText(conn, 'Start'))
  const dryJob = await waitFor(
    'dry job enqueued',
    () =>
      conn.evalJs(
        `window.argus.distill.runsAll().then((rs) => rs.find((r) => r.caseSlug === ${JSON.stringify(SLUG)} && r.dryRun) ?? null)`
      ),
    20000
  )
  check('dry run enqueued from the view', dryJob.dryRun === true, {
    id: dryJob.id,
    state: dryJob.state
  })
  const t1 = Date.now()
  const dryDone = await waitFor(
    'dry job terminal',
    async () => {
      const rs = await conn.evalJs(`window.argus.distill.runsAll()`)
      const j = rs.find((r) => r.id === dryJob.id)
      return j && TERMINAL.includes(j.state) ? j : null
    },
    25 * 60 * 1000
  )
  console.error(
    `dry run terminal after ${Math.round((Date.now() - t1) / 1000)}s: ${JSON.stringify(dryDone)}`
  )
  check('dry run reached done', dryDone.state === 'done', {
    state: dryDone.state,
    error: dryDone.error
  })

  // ── live progress, as the RENDERER saw it ─────────────────────────────────────────────────
  const all = await conn.evalJs(`window.__argusProgress`)
  const progress = (all ?? []).filter((p) => p.jobId === dryJob.id)
  const phases = [...new Set(progress.map((p) => p.phase))]
  console.error(`progress phases for #${dryJob.id}: ${JSON.stringify(phases)}`)
  check('progress broadcasts reached the renderer', progress.length > 0, progress.length)
  check('>= 3 distinct progress phases observed', phases.length >= 3, phases)
  check(
    'a materialize phase named its target',
    progress.some((p) => p.phase === 'materialize' && p.detail),
    progress.filter((p) => p.phase === 'materialize').map((p) => p.detail)
  )
  check(
    'a dossier tool tick was observed',
    progress.some((p) => p.phase === 'dossier' && (p.toolCalls ?? 0) >= 1),
    Math.max(0, ...progress.filter((p) => p.phase === 'dossier').map((p) => p.toolCalls ?? 0))
  )
  check('no staging phase on a dry run', !phases.includes('staging'), phases)

  // ── the view selected the new row and rendered the strip + structured dossier ─────────────
  await waitFor('the dry run selected', async () => {
    const id = await conn.evalJs(
      `(() => { const b = document.querySelector('[data-testid="run-row"][aria-current="true"]'); return b ? b.textContent.trim() : null })()`
    )
    return id && id.includes(`#${dryJob.id}`) ? id : null
  })
  check('the dry run is auto-selected in the rail', true, `#${dryJob.id}`)
  await waitFor('the dry run strip', () =>
    conn.evalJs(
      `(() => { const n = document.querySelector('[data-testid="strip-staged"]'); return n && n.dataset.state === 'skipped' ? true : null })()`
    )
  )
  const dryStrip = await conn.evalJs(
    `document.querySelector('[data-testid="strip-staged"]').textContent`
  )
  check(
    'staged node reads not staged (dry run)',
    dryStrip.includes('not staged (dry run)'),
    dryStrip
  )
  const dossier = await conn.evalJs(`(() => {
    const card = document.querySelector('[data-testid="card-dossier"]')
    if (!card) return null
    return { text: card.textContent, spans: card.querySelectorAll('span').length }
  })()`)
  check(
    'dossier card renders >= 1 resolved cite chip',
    Boolean(dossier) && /finding \d+|s\d+:t\d+|ev /.test(dossier.text),
    (dossier?.text ?? '').slice(0, 240)
  )

  // ── compare the dry run with the case's real run ──────────────────────────────────────────
  const options = await conn.evalJs(`(() => {
    const s = document.querySelector('select[aria-label="Compare with"]')
    return s ? [...s.options].map((o) => ({ value: o.value, label: o.textContent })) : null
  })()`)
  check('compare select lists a sibling run', (options ?? []).length >= 2, options)
  await setReactValue(
    conn,
    'select[aria-label="Compare with"]',
    String(options[1].value),
    'HTMLSelectElement'
  )
  await waitFor('two columns', () =>
    conn.evalJs(`document.querySelector('[data-testid="compare-columns"]') ? true : null`)
  )
  const columns = await conn.evalJs(
    `document.querySelectorAll('[data-testid="compare-columns"] [data-testid="strip-input"]').length`
  )
  check('compare renders two run columns', columns === 2, columns)

  // ── Observability: the Distillation card group ────────────────────────────────────────────
  await openSettingsPage(conn, 'Observability')
  check(
    'Observability settings offers the dashboard',
    await clickButtonByText(conn, 'Open dashboard')
  )
  await waitFor('distillation cards', () =>
    conn.evalJs(`document.querySelector('[data-card-id="distill.drySpend"]') ? true : null`)
  )
  const cards = await conn.evalJs(`(() => {
    const byId = (id) => document.querySelector('[data-card-id="' + id + '"]')?.textContent ?? null
    return {
      runs: byId('distill.runs'),
      spend: byId('distill.spend'),
      failedSpend: byId('distill.failedSpend'),
      drySpend: byId('distill.drySpend'),
      openRuns: [...document.querySelectorAll('button')].some((b) => b.textContent.trim() === 'Open runs')
    }
  })()`)
  console.error(`distillation cards: ${JSON.stringify(cards)}`)
  check(
    'the dashboard renders the whole Distillation group',
    Boolean(cards.runs && cards.spend && cards.failedSpend && cards.drySpend),
    cards
  )
  check(
    'dry-run spend card is non-zero',
    /\$\d+\.\d\d/.test(cards.drySpend ?? '') && !(cards.drySpend ?? '').includes('$0.00'),
    cards.drySpend
  )
  check(
    'real-run spend card is non-zero and excludes the dry run',
    /\$\d+\.\d\d/.test(cards.spend ?? '') && !(cards.spend ?? '').includes('$0.00'),
    cards.spend
  )
  check('the group offers the dev-only Open runs jump', cards.openRuns === true, cards.openRuns)

  // ── Settings → Agent no longer carries the spend row ──────────────────────────────────────
  await openSettingsPage(conn, 'Agent')
  const agent = await conn.evalJs(`(() => ({
    background: document.body.textContent.includes('Background work'),
    spendRow: /completed run/.test(document.body.textContent)
  }))()`)
  check('Settings → Agent is the page on screen', agent.background === true, agent)
  check('no distillation spend row in Settings → Agent', agent.spendRow === false, agent)

  // ── cost of the two runs, for the report ──────────────────────────────────────────────────
  const db = new DatabaseSync(DB)
  const rows = db
    .prepare(
      `SELECT id, dry_run, state, cost_usd, duration_ms, pipeline, item_count FROM distill_jobs WHERE case_slug=? ORDER BY id`
    )
    .all(SLUG)
  db.close()
  console.error(`job rows: ${JSON.stringify(rows, null, 2)}`)
  const total = rows.reduce((a, r) => a + (r.cost_usd ?? 0), 0)
  console.error(`total cost across both runs: $${total.toFixed(4)}`)
  console.error(`wall time: ${Math.round((Date.now() - t00) / 1000)}s`)
  check(
    'both rows are stamped pipeline=v3',
    rows.length === 2 && rows.every((r) => r.pipeline === 'v3'),
    rows.map((r) => `${r.id}:${r.pipeline}`)
  )

  conn.close()
  report()
}

main().catch((e) => {
  console.error('GATE ERROR', e)
  process.exit(1)
})
