#!/usr/bin/env node
/**
 * Routines increment 4 runtime gate
 * (spec argus-docs/superpowers/specs/2026-08-08-routines-increment-4-design.md §7.2).
 *
 * What this gate answers, and nothing else:
 *   1. the keep-alive toggle round-trips through the UI into config/settings.json
 *   2. closing the main window with it ON leaves the process alive
 *   3. a scheduled routine fires with NO window open (a routine_runs row appears)
 *   4. reopening shows that run in Home's inbox
 *
 * The tray icon, its menu, and both notifications are NOT here: they are not in the page, so CDP
 * cannot see them. They are the exit check's job — do not add a DOM assertion that claims to
 * cover them.
 *
 * WHY STEP 4 NEEDS A HUMAN, AND WHY THAT IS CORRECT RATHER THAN A GAP. Once the only window is
 * closed there is no page target left on the debug port at all — nothing for `Runtime.evaluate`
 * to run inside. The only in-process paths that recreate the window (the tray's Open item, the
 * second-instance handler, the run-finished notification's click, macOS `activate`) are either a
 * real OS interaction or gated behind `requestSingleInstanceLock()`, which this gate deliberately
 * does NOT hold — increment 4 §2.1 takes the lock only when `ARGUS_HOME` is unset, precisely so
 * every isolated-home gate (this one included) keeps working. So there is no code path left for a
 * *script* to reopen the window with — only a person clicking the tray icon (or the notification)
 * can. This gate waits for that click rather than performing it: it polls the debug port until a
 * page target reappears, then re-attaches and asserts what that window shows. That split — script
 * proves the mechanism, a person supplies the one action that lives outside the page — is the
 * same allocation the header above describes for the tray icon itself, just paid at gate-run time
 * instead of being punted to the exit check.
 *
 * DEVIATION FROM THE TASK BRIEF, RECORDED HERE RATHER THAN SILENTLY "FIXED": the brief says "save
 * a routine with a 1-minute interval schedule" and "read the pid from the dev launch". Neither
 * survived contact with the actual code:
 *   - `MIN_INTERVAL_MINUTES` (shared/routines.ts) is 5, and `saveDraft` in RoutinesPage.tsx
 *     enforces it ("runs are serial, and a shorter one would hold the single slot continuously").
 *     A 1-minute schedule is not save-able through the UI at all. This gate uses 5 and waits
 *     accordingly — the interval is genuinely ~5-6 minutes wall-clock, not 1.
 *   - A human-read PID is exactly the kind of thing that goes stale the moment `electron-vite`
 *     spawns Electron through an intermediate wrapper process — the terminal's own PID is not
 *     reliably the one holding the debug port. `scripts/cdp-diagnostics.mjs` already solves this
 *     precisely (resolve the PID that OWNS the listening socket on CDP_PORT, then verify its
 *     command line names this worktree before trusting it) — reused here verbatim rather than
 *     re-deriving a weaker version of the same idea.
 *
 * Usage:
 *   1. ARGUS_HOME=<scratch> npx electron-vite dev --remoteDebuggingPort 9228
 *   2. ARGUS_HOME=<scratch> node scripts/cdp-routines-tray.mjs
 *
 * When the terminal prints "waiting for a window to reopen", click "Open Argus" from the tray
 * icon (or click the run-finished notification once it appears) — that is the one action this
 * script cannot perform for itself; see the note above.
 *
 * Env: CDP_PORT (default 9228), ARGUS_HOME (required — the gate reads the same db/settings.json
 * the running app has open), ROUTINE_ID / ROUTINE_NAME (default 'tray-gate' / 'Tray gate' — keep
 * them deriving to the same id, or the re-run idempotency check below stops finding its own row).
 *
 * Exits 0 when every assertion passes, 1 otherwise.
 */
import fs from 'node:fs'
import path, { dirname, resolve as resolvePath } from 'node:path'
import { execFileSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { DatabaseSync } from 'node:sqlite'
import {
  listTargets as list,
  connect,
  sleep,
  waitFor,
  check,
  report,
  mainWindow
} from './lib/cdp.mjs'

const PORT = process.env.CDP_PORT || '9228'
const HOME = process.env.ARGUS_HOME
if (!HOME) throw new Error('ARGUS_HOME is required — this gate reads db/settings.json directly')
const ROUTINE = process.env.ROUTINE_ID || 'tray-gate'
const ROUTINE_NAME = process.env.ROUTINE_NAME || 'Tray gate'
// shared/routines.ts MIN_INTERVAL_MINUTES — see the deviation note above.
const INTERVAL_MINUTES = 5
const SETTINGS_PATH = path.join(HOME, 'config', 'settings.json')
const DB_PATH = path.join(HOME, 'argus.db')

// This file lives at <worktree>/app/scripts/cdp-routines-tray.mjs — two levels up is the
// worktree root, derived rather than hardcoded so ownership verification is correct under any
// worktree's path. Same technique as scripts/cdp-diagnostics.mjs.
const WORKTREE_ROOT = resolvePath(dirname(fileURLToPath(import.meta.url)), '..', '..')

// ── OS-level PID resolution, reused from scripts/cdp-diagnostics.mjs ───────────────────────────

function runPowershell(script) {
  try {
    return execFileSync('powershell', ['-NoProfile', '-Command', script], {
      encoding: 'utf8',
      timeout: 5000
    }).trim()
  } catch {
    return null
  }
}

/** PID of the process with a LISTENING socket on `port`, or null if none / undeterminable. */
function resolveListeningPid(port) {
  if (process.platform === 'win32') {
    const out = runPowershell(
      `try { $r = Get-NetTCPConnection -LocalPort ${port} -State Listen -ErrorAction Stop | ` +
        `Select-Object -First 1 -ExpandProperty OwningProcess; if ($r) { Write-Output $r } ` +
        `else { Write-Output 'NOMATCH' } } catch { Write-Output 'NOMATCH' }`
    )
    if (out === null || out === 'NOMATCH' || out === '') return null
    const pid = Number.parseInt(out, 10)
    return Number.isFinite(pid) ? pid : null
  }
  if (process.platform === 'darwin' || process.platform === 'linux') {
    try {
      const out = execFileSync('lsof', ['-ti', `tcp:${port}`, '-sTCP:LISTEN'], {
        encoding: 'utf8',
        timeout: 5000
      }).trim()
      const pid = Number.parseInt(out.split(/\s+/)[0], 10)
      return Number.isFinite(pid) ? pid : null
    } catch {
      return null
    }
  }
  return null
}

/** Full command line of `pid`, or null if it could not be resolved. */
function resolveCommandLine(pid) {
  if (process.platform === 'win32') {
    const out = runPowershell(
      `try { $r = Get-CimInstance Win32_Process -Filter 'ProcessId=${pid}' -ErrorAction Stop | ` +
        `Select-Object -ExpandProperty CommandLine; if ($r) { Write-Output $r } ` +
        `else { Write-Output 'NOMATCH' } } catch { Write-Output 'NOMATCH' }`
    )
    return out === null || out === 'NOMATCH' || out === '' ? null : out
  }
  if (process.platform === 'darwin' || process.platform === 'linux') {
    try {
      const out = execFileSync('ps', ['-o', 'command=', '-p', String(pid)], {
        encoding: 'utf8',
        timeout: 5000
      }).trim()
      return out || null
    } catch {
      return null
    }
  }
  return null
}

/**
 * Resolve the PID bound to CDP_PORT and confirm it is THIS worktree's process, not some other
 * worktree's app answering the same port (memory: concurrent worktree sessions collide on the
 * usual CDP ports and the loser's `/json/list` silently serves a different checkout's window).
 * Returns null (with a loud warning, not a hard failure) when the platform or tooling cannot
 * answer — an inability to check is not evidence of a collision.
 */
function resolveOwnedPid(port) {
  const plat = process.platform
  if (plat !== 'win32' && plat !== 'darwin' && plat !== 'linux') {
    console.error(`WARNING: cannot resolve the CDP_PORT ${port} PID on platform "${plat}".`)
    return null
  }
  const pid = resolveListeningPid(port)
  if (pid === null) {
    console.error(`WARNING: nothing is listening on CDP_PORT ${port} yet.`)
    return null
  }
  const cmdLine = resolveCommandLine(pid)
  if (!cmdLine) {
    console.error(`WARNING: PID ${pid} owns port ${port} but its command line could not be read.`)
    return pid
  }
  const matches =
    plat === 'win32'
      ? cmdLine.toLowerCase().includes(WORKTREE_ROOT.toLowerCase())
      : cmdLine.includes(WORKTREE_ROOT)
  if (!matches) {
    console.error(`Port ${port} is answering, but not from this worktree.`)
    console.error(`  Expected worktree: ${WORKTREE_ROOT}`)
    console.error(`  Actual process (PID ${pid}): ${cmdLine}`)
    process.exit(1)
  }
  return pid
}

/** `process.kill(pid, 0)` throws ESRCH when the process is gone. Any other error (e.g. a
 *  permission error) still proves the process exists. */
function isAlive(pid) {
  try {
    process.kill(pid, 0)
    return true
  } catch (e) {
    return e.code !== 'ESRCH'
  }
}

// ── small DOM helpers, same idiom as the other cdp-*.mjs gates ─────────────────────────────────

const clickSelector = (conn, sel) =>
  conn.evalJs(`(() => {
    const el = document.querySelector(${JSON.stringify(sel)})
    if (!el) return false
    el.click()
    return true
  })()`)

/** Click the settings-nav button (or any button-bearing container) whose visible label starts
 *  with `label`. Same helper as cdp-dynamic-theme-views.mjs / cdp-light-theme.mjs. */
const clickByLabel = (conn, containerSel, label) =>
  conn.evalJs(`(() => {
    const root = document.querySelector(${JSON.stringify(containerSel)})
    if (!root) return false
    const btn = [...root.querySelectorAll('button')].find(
      b => (b.textContent || '').trim().startsWith(${JSON.stringify(label)})
    )
    if (!btn) return false
    btn.click()
    return true
  })()`)

/** Click the FIRST button whose visible text is exactly `text`. */
const clickButtonExact = (conn, text) =>
  conn.evalJs(`(() => {
    const b = [...document.querySelectorAll('button')].find(x => (x.textContent || '').trim() === ${JSON.stringify(text)})
    if (!b) return false
    b.click()
    return true
  })()`)

/** Click the button whose `aria-label` is exactly `label`. Matched by property equality rather
 *  than an attribute-selector string, so a literal '·' in the label (routine edit buttons carry
 *  one) needs no CSS-selector escaping — same reasoning as lib/cdp.mjs's SURFACE comment. */
const clickAriaLabel = (conn, label) =>
  conn.evalJs(`(() => {
    const b = [...document.querySelectorAll('button')].find(x => x.getAttribute('aria-label') === ${JSON.stringify(label)})
    if (!b) return false
    b.click()
    return true
  })()`)

/** Focus `sel` and type `text` through CDP's Input domain (real keyboard events, so React's
 *  controlled inputs see it) — same technique as cdp-light-theme.mjs's `typeInto`. */
async function typeInto(conn, sel, text) {
  await conn.evalJs(`document.querySelector(${JSON.stringify(sel)})?.focus()`)
  await conn.insertText(text)
}

/** Idempotent: only clicks the gear if the Settings sidebar is not already up (it is a TOGGLE —
 *  a second click while already on Settings closes it). */
async function gotoSettings(conn) {
  const already = await conn.evalJs(
    `!!document.querySelector('nav[aria-label="Settings sections"]')`
  )
  if (already) return
  await clickSelector(conn, 'button[aria-label="Settings"]')
  await waitFor('the Settings sidebar to appear', () =>
    conn.evalJs(`!!document.querySelector('nav[aria-label="Settings sections"]')`)
  )
}

async function gotoSettingsPage(conn, label) {
  await gotoSettings(conn)
  await clickByLabel(conn, 'nav[aria-label="Settings sections"]', label)
}

/**
 * NAVIGATE TO HOME AND PROVE IT, before asserting anything about its contents. Copied verbatim
 * from cdp-routines-inbox.mjs's own comment: increment 3's first draft ran its whole DOM section
 * from Settings and reported "Home shows no inbox" as a pass because nothing checked WHERE it
 * was. The wordmark is the Home affordance (`aria-label="All cases"`); the Observability page
 * also renders a bare `h1`, hence the second half of the check.
 */
async function gotoHomeAndAssertArrival(conn) {
  await clickSelector(conn, '[aria-label="All cases"]')
  await waitFor(
    'Home to be on screen',
    async () =>
      await conn.evalJs(
        `!!document.querySelector('h1') && !document.body.innerText.startsWith('ARGUS\\nObservability')`
      ),
    15000
  )
  check(
    'the gate is actually on Home before asserting about it',
    await conn.evalJs(
      `!!document.querySelector('h1') && !document.body.innerText.startsWith('ARGUS\\nObservability')`
    )
  )
}

const INBOX = `document.querySelector('[data-testid="routine-inbox"]')`
const inboxText = (conn) =>
  conn.evalJs(`(() => { const e = ${INBOX}; return e ? e.innerText : null })()`)

// ── 0. resolve and verify the process this gate is about to drive ──────────────────────────────

const gatePid = resolveOwnedPid(PORT)
if (gatePid !== null)
  console.error(`CDP_PORT ${PORT} is owned by PID ${gatePid} (verified this worktree).`)

const targets = await list(PORT)
if (targets.length === 0) {
  throw new Error(`no page target on CDP port ${PORT} — is the app running with a debug port?`)
}
let main = await connect(mainWindow(targets) ?? targets[0])

// ── 1. Home, proven, then a clean inbox slate ───────────────────────────────────────────────────
// A previous run of this gate (or a human's own session) can leave reviewed AND unreviewed rows
// behind. Clear first, through the same IPC the UI uses, so what this run asserts at the end is
// unambiguously the row it produced itself — same reasoning as cdp-routines-inbox.mjs.
await gotoHomeAndAssertArrival(main)
await main.evalJs(`window.argus.routines.markAllReviewed()`)
await sleep(600)
const payload0 = await main.evalJs(`window.argus.routines.list()`)
check(
  'nothing is waiting to be reviewed at the start',
  payload0.unreviewedCount === 0,
  payload0.unreviewedCount
)

// ── 2. Settings -> General: the keep-alive switch round-trips to disk ──────────────────────────

const SWITCH = '[role="switch"][aria-label="Keep running in the background"]'
await gotoSettingsPage(main, 'General')
await waitFor('General settings to be on screen', () =>
  main.evalJs(`!!document.querySelector(${JSON.stringify(SWITCH)})`)
)
check(
  'arrived on Settings -> General before asserting about it',
  await main.evalJs(`!!document.querySelector(${JSON.stringify(SWITCH)})`)
)

// Assert the precondition rather than assuming it — a re-run of this gate against a home it has
// already configured would otherwise find the switch already ON and this check would pass either
// way, which is exactly the "holds on a fresh home, silently vacuous on a re-run" trap.
const checkedBefore = await main.evalJs(
  `document.querySelector(${JSON.stringify(SWITCH)})?.getAttribute('aria-checked')`
)
if (checkedBefore !== 'true') {
  await clickSelector(main, SWITCH)
  await waitFor('the switch to report checked after the click', () =>
    main.evalJs(
      `document.querySelector(${JSON.stringify(SWITCH)})?.getAttribute('aria-checked') === 'true'`
    )
  )
} else {
  console.error('keepAliveInBackground was already on (re-run of this gate) — leaving it on.')
}
check(
  'the switch reads checked in the DOM',
  (await main.evalJs(
    `document.querySelector(${JSON.stringify(SWITCH)})?.getAttribute('aria-checked')`
  )) === 'true'
)

// The IPC round-trip the click drove already resolved (waitFor above only returns once the
// store's local state reflects it), but the write to disk is a separate async hop — give it a
// moment before reading the file back.
await sleep(500)
let settingsOnDisk
try {
  settingsOnDisk = JSON.parse(fs.readFileSync(SETTINGS_PATH, 'utf8'))
} catch (e) {
  settingsOnDisk = null
  console.error(`could not read ${SETTINGS_PATH}: ${e.message}`)
}
check(
  'general.keepAliveInBackground round-tripped through the UI into config/settings.json',
  settingsOnDisk?.general?.keepAliveInBackground === true,
  settingsOnDisk?.general
)

// ── 3. Settings -> Routines: save a routine on a 5-minute interval schedule ────────────────────
// (5, not the brief's 1 — MIN_INTERVAL_MINUTES enforces a floor of 5. See the header note.)

// "New routine" is unconditionally rendered by RoutinesPage regardless of create/edit state
// below, so its presence is a page-specific arrival proof — not just "some button exists",
// which would also be true on General (the Settings gear alone satisfies that).
const NEW_ROUTINE_BTN = `[...document.querySelectorAll('button')].find(b => (b.textContent||'').trim() === 'New routine')`
await gotoSettingsPage(main, 'Routines')
await waitFor('the Routines page to be on screen', () => main.evalJs(`!!(${NEW_ROUTINE_BTN})`))

const payloadBeforeRoutine = await main.evalJs(`window.argus.routines.list()`)
const existing = payloadBeforeRoutine.routines.find((r) => r.id === ROUTINE)
check(
  `arrived on Settings -> Routines before ${existing ? 'editing' : 'creating'} the gate routine`,
  await main.evalJs(`!!(${NEW_ROUTINE_BTN})`)
)

if (existing) {
  // Re-run of this gate against a home it has already seeded. Edit rather than create — a second
  // "New routine" with the same derived id is refused by saveDraft's clash guard.
  console.error(`routine "${ROUTINE}" already exists (re-run) — editing it instead of creating.`)
  await clickAriaLabel(main, `edit · ${existing.name}`)
} else {
  await clickButtonExact(main, 'New routine')
}
await waitFor('the routine editor to open', () =>
  main.evalJs(`!!document.querySelector('input[placeholder="e.g. Nightly crash sweep"]')`)
)

if (!existing) {
  await typeInto(main, 'input[placeholder="e.g. Nightly crash sweep"]', ROUTINE_NAME)
  await typeInto(
    main,
    'textarea[placeholder^="What this routine should do"]',
    'Reply with exactly one line: tray gate ok. Use no tools.'
  )
}

// Schedule -> "Every N minutes", if not already selected.
const scheduleSelected = await main.evalJs(
  `document.querySelector('button[role="combobox"][aria-label="Schedule"]')?.textContent`
)
if (scheduleSelected !== 'Every N minutes') {
  await clickSelector(main, 'button[role="combobox"][aria-label="Schedule"]')
  await waitFor('the Schedule options to open', () =>
    main.evalJs(`!!document.querySelector('[role="listbox"][aria-label="Schedule"]')`)
  )
  await main.evalJs(`(() => {
    const opt = [...document.querySelectorAll('[role="listbox"][aria-label="Schedule"] [role="option"]')]
      .find(o => o.textContent.trim() === 'Every N minutes')
    if (!opt) return false
    opt.click()
    return true
  })()`)
}
const MINUTES_INPUT = `[...document.querySelectorAll('label')].find(l => (l.textContent||'').trim().startsWith('Minutes'))?.querySelector('input')`
await waitFor('the Minutes field to appear', () => main.evalJs(`!!(${MINUTES_INPUT})`))
await main.evalJs(`(${MINUTES_INPUT}).focus()`)
await main.key('a', { modifiers: 2 })
await main.insertText(String(INTERVAL_MINUTES))
await waitFor(`the Minutes field to read ${INTERVAL_MINUTES}`, () =>
  main.evalJs(`(${MINUTES_INPUT})?.value === ${JSON.stringify(String(INTERVAL_MINUTES))}`)
)

await clickButtonExact(main, 'Save')
await waitFor('the routine editor to close after Save', () =>
  main.evalJs(`!document.querySelector('input[placeholder="e.g. Nightly crash sweep"]')`)
)
check(
  'saving the routine raised no mutation error',
  (await main.evalJs(`!document.querySelector('[role="alert"]')`)) === true
)

const payloadAfterSave = await main.evalJs(`window.argus.routines.list()`)
const savedRoutine = payloadAfterSave.routines.find((r) => r.id === ROUTINE)
check(
  `the routine "${ROUTINE}" loaded from config/routines.json after saving`,
  !!savedRoutine,
  payloadAfterSave.routines.map((r) => r.id)
)
check(
  `the routine is on a ${INTERVAL_MINUTES}-minute interval schedule`,
  savedRoutine?.schedule?.kind === 'interval' &&
    savedRoutine?.schedule?.everyMinutes === INTERVAL_MINUTES,
  savedRoutine?.schedule
)
check('the routine is enabled', savedRoutine?.enabled === true)

// Baseline read straight from SQLite (not the capped-at-50 `runs` array) — the id every check
// after this point measures forward from.
const db = new DatabaseSync(DB_PATH, { readOnly: true })
const baselineRow = db
  .prepare(`SELECT COALESCE(MAX(id), 0) AS maxId FROM routine_runs WHERE routine_id = ?`)
  .get(ROUTINE)
const baselineMaxId = baselineRow.maxId
db.close()

// ── 4. close the only window; the process must survive ─────────────────────────────────────────

try {
  await main.evalJs(`window.close()`)
} catch (e) {
  // Expected on some Electron/Chromium versions: the execution context can be torn down before
  // Runtime.evaluate's reply is sent. The assertions below are what actually prove the close
  // happened, not this call resolving cleanly.
  console.error(`window.close() eval did not cleanly resolve (expected): ${e.message}`)
}
await sleep(3000)

const targetsAfterClose = await list(PORT).catch(() => null)
check(
  'the debug port still answers with the window closed (process alive)',
  targetsAfterClose !== null && targetsAfterClose.length === 0,
  targetsAfterClose
)
if (gatePid !== null) {
  check(`process ${gatePid} is still alive 3s after closing the main window`, isAlive(gatePid))
} else {
  console.error(
    'WARNING: could not resolve a PID earlier — skipping the process.kill(pid,0) check.'
  )
}

// ── 5. wait out the interval: a routine_runs row appears with NO window open ───────────────────
// Budget: due at save-time + 5:00, detected within one 30s scheduler tick (worst case +0:30),
// plus real driver latency for the turn itself. 8 minutes covers that with margin; read from
// SQLite only — there is no UI to read from at this point (brief's own instruction).

console.error(
  `waiting up to 8 minutes for the ${INTERVAL_MINUTES}-minute schedule to fire with no window open...`
)
const newRun = await waitFor(
  'a new scheduled routine_runs row with no window open',
  () => {
    const d = new DatabaseSync(DB_PATH, { readOnly: true })
    try {
      const row = d
        .prepare(
          `SELECT * FROM routine_runs WHERE routine_id = ? AND id > ? AND trigger_kind = 'scheduled' AND finished_at IS NOT NULL ORDER BY id ASC LIMIT 1`
        )
        .get(ROUTINE, baselineMaxId)
      return row ?? false
    } finally {
      d.close()
    }
  },
  8 * 60 * 1000
).catch(() => null)

check('a routine_runs row appeared while no window was open', !!newRun, newRun)
check(
  'the row is trigger_kind=scheduled (not manual, not catchup)',
  newRun?.trigger_kind === 'scheduled'
)
check('the run finished cleanly', newRun?.status === 'ok', newRun?.status)
check('the run is unreviewed (nothing was open to review it)', newRun?.reviewed_at === null)

// ── 6. reopen a window — a human's job, this script's is to wait for and re-attach to it ───────

console.error('')
console.error('====================================================================')
console.error('waiting for a window to reopen. Click "Open Argus" from the tray icon')
console.error('(or click the run-finished notification, if one is showing) now.')
console.error('CDP cannot do this itself — see the header comment for why.')
console.error('====================================================================')
console.error('')

const reopened = await waitFor(
  'a page target to reappear on the debug port',
  async () => {
    const t = await list(PORT).catch(() => [])
    return t.length > 0 ? t : false
  },
  10 * 60 * 1000
).catch(() => null)

if (!reopened) {
  check('a window reopened within 10 minutes', false)
  report()
} else {
  main = await connect(mainWindow(reopened) ?? reopened[0])
  await gotoHomeAndAssertArrival(main)

  const text = await inboxText(main)
  check('the inbox is present on the reopened Home', text !== null, text?.slice(0, 240))
  check(
    'the inbox names the routine',
    text !== null && new RegExp(ROUTINE_NAME, 'i').test(text),
    text
  )

  const payloadFinal = await main.evalJs(`window.argus.routines.list()`)
  check(
    'unreviewedCount is non-zero on reopen',
    payloadFinal.unreviewedCount > 0,
    payloadFinal.unreviewedCount
  )
  check(
    'the scheduled run this gate produced is among the unreviewed runs',
    payloadFinal.runs.some(
      (r) => r.routineId === ROUTINE && r.reviewedAt === null && r.trigger === 'scheduled'
    )
  )

  report()
}
