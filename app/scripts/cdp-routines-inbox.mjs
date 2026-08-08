#!/usr/bin/env node
/**
 * Routines increment 3 runtime gate
 * (spec argus-docs/superpowers/specs/2026-08-08-routines-increment-3-design.md §8).
 *
 * The renderer suite proves the inbox filters, renders and clears correctly against a mocked
 * `window.argus`. It cannot prove the thing the increment actually promises: that a run finishing
 * in MAIN reaches a Home screen nobody touched. That path — service write → `safeNotify` →
 * `routinesBroadcast` → `routines:changed` → the renderer store's re-read → `RoutineInbox` —
 * exists only in the real app, and every jsdom test stubs it out at the first hop.
 *
 * What this gate answers, and nothing else:
 *   1. Home starts with no inbox (nothing to review)
 *   2. a run started while sitting on Home makes the inbox appear WITHOUT a manual refresh
 *   3. the run's summary renders as MARKDOWN (a real <h2>), not as literal `##`
 *   4. the routine's case card carries the Routine chip and an "N to review" count
 *   5. Mark reviewed clears the row, and Settings → Recent runs agrees it is reviewed
 *   6. the count is the SQL count, not the length of the capped array
 *
 * Relaunch persistence and the crash-reconcile path are checked separately (phase 2), because
 * they need a process restart this script cannot perform on itself.
 *
 * Usage:
 *   1. ARGUS_HOME=<scratch> npx electron-vite dev --remoteDebuggingPort 9227
 *   2. node scripts/cdp-routines-inbox.mjs
 *
 * Env: CDP_PORT (default 9227), ROUTINE_ID (default inbox-gate).
 * Exits 0 when every assertion passes, 1 otherwise.
 */
import {
  listTargets as list,
  connect,
  sleep,
  waitFor,
  check,
  report,
  mainWindow
} from './lib/cdp.mjs'

const PORT = process.env.CDP_PORT || '9227'
const ROUTINE = process.env.ROUTINE_ID || 'inbox-gate'

const targets = await list(PORT)
if (targets.length === 0) {
  throw new Error(`no page target on CDP port ${PORT} — is the app running with a debug port?`)
}
const main = await connect(mainWindow(targets) ?? targets[0])

/** The inbox section, or null. Its own testid, so this never matches a case card by accident. */
const INBOX = `document.querySelector('[data-testid="routine-inbox"]')`

const inboxText = () =>
  main.evalJs(`(() => { const e = ${INBOX}; return e ? e.innerText : null })()`)

// --- 0. make sure we are on Home, with a clean inbox ---
/**
 * NAVIGATE FIRST, AND PROVE IT. The inbox renders only inside `CaseDashboard`, and the active
 * view is persisted across reloads — so a gate that starts wherever the app happens to be will
 * report "Home shows no inbox" from the Settings page and call it a pass. That happened on the
 * first draft of this gate: it sat on Settings → Observability and every DOM assertion below it
 * was vacuous. The wordmark is the Home affordance (`aria-label="All cases"`).
 */
await main.evalJs(`(() => {
  const b = document.querySelector('[aria-label="All cases"]')
  if (b) b.click()
  return !!b
})()`)
await waitFor(
  'Home to be on screen',
  async () =>
    await main.evalJs(
      `!!document.querySelector('h1') && !document.body.innerText.startsWith('ARGUS\\nObservability')`
    ),
  15000
)
check(
  'the gate is actually on Home before asserting about it',
  await main.evalJs(`!!document.querySelector('h1')`)
)

// A previous run of this gate leaves reviewed rows behind, which is a legitimate state but not
// the one assertion 1 describes. Clear first, through the same IPC the UI uses.
await main.evalJs(`window.argus.routines.markAllReviewed()`)
await sleep(600)

const payload0 = await main.evalJs(`window.argus.routines.list()`)
check(
  'the seeded routine loaded from config/routines.json',
  payload0.routines.some((r) => r.id === ROUTINE),
  payload0.routines.map((r) => r.id)
)
check(
  'nothing is waiting to be reviewed at the start',
  payload0.unreviewedCount === 0,
  payload0.unreviewedCount
)
check('Home shows no inbox when there is nothing to review', (await inboxText()) === null)

// --- 1. start a run, and DO NOT touch the page afterwards ---
// This is the whole point: the inbox must arrive on the broadcast, not because we navigated.
await main.evalJs(`window.argus.routines.runNow(${JSON.stringify(ROUTINE)})`)

// The turn runs a real driver, so allow generously. `waitFor` polls the DOM only.
const appeared = await waitFor(
  'the inbox to appear on an untouched Home screen',
  async () => (await inboxText()) !== null,
  240000
)
check('a finished run makes the inbox appear with no manual refresh', !!appeared)

const text = await inboxText()
check('the inbox names the routine', /Inbox gate/.test(text), text?.slice(0, 200))
// Case-insensitive: the chip is uppercased in CSS and `innerText` reports the rendered casing.
check('the run is badged with its trigger', /manual|scheduled|catch-up/i.test(text))

// --- 2. markdown, not literal syntax ---
// `##` must have become an element. Asserting the absence of "##" alone would pass on an empty
// box, so require the heading element AND its text.
const heading = await main.evalJs(`(() => {
  const e = ${INBOX}
  if (!e) return null
  const h = e.querySelector('h1,h2,h3')
  return h ? h.textContent : null
})()`)
check('the summary renders markdown as a real heading', heading === 'All clear', heading)
check('the summary does not show literal markdown syntax', !/##\s*All clear/.test(text))

// --- 3. the case card ---
/**
 * MEASURED, not assumed: a case created by the run that just fired is NOT in the grid yet.
 * `App.tsx` fetches `cases` on mount and reloads it only on navigation / delete / create /
 * mode-switch — nothing subscribes `cases` to `routines:changed`. So a first-ever run of a
 * routine creates its case, `origin` is correct in the database immediately (verified: the main
 * process reports `routine-inbox-gate|routine` while the grid still shows nothing), and the card
 * appears only once the renderer refetches.
 *
 * That lag is pre-existing behaviour of Home's data loading, not of this increment, and the spec
 * only promises the INBOX arrives live. The reload below is what a user does by navigating; the
 * gate reloads instead so it does not depend on which chrome buttons exist.
 *
 * Measured precisely, so the lag is recorded rather than guessed at:
 *   - a FIRST-EVER run of a routine creates its case, and the grid shows no card at all until a
 *     refetch (observed on a fresh home: `cases known to main` already reported
 *     `routine-inbox-gate|routine` while the grid held zero case-title nodes);
 *   - a LATER run finds the card already there, and its "N to review" count DOES update live,
 *     because that number is derived from the routines payload the store refreshes — only the
 *     card's existence and its `origin` come from `cases`.
 *
 * Asserting "no card before reload" would therefore pass on a fresh home and fail on a re-run,
 * so what is asserted here is the invariant instead: origin is correct in the database the moment
 * the run has finished, whatever the grid is currently showing.
 */
const originInDb = await main.evalJs(
  `window.argus.cases.list().then((cs) => (cs.find((c) => c.slug === 'routine-inbox-gate') || {}).origin ?? null)`
)
check(
  'the case is recorded routine-origin as soon as the run has run',
  originInDb === 'routine',
  originInDb
)

await main.send('Page.enable')
await main.send('Page.reload', {})
await waitFor(
  'the reloaded Home',
  async () => {
    try {
      return (await main.evalJs('document.readyState')) === 'complete'
    } catch {
      return false // navigation tears down the execution context mid-flight
    }
  },
  30000
)
await waitFor(
  'the routine case card',
  async () =>
    await main.evalJs(
      `[...document.querySelectorAll('[data-testid="case-title"]')].some((e) => /Routine: Inbox gate/.test(e.textContent || ''))`
    ),
  20000
)

const card = await main.evalJs(`(() => {
  const t = [...document.querySelectorAll('[data-testid="case-title"]')]
    .find((x) => /Routine: Inbox gate/.test(x.textContent || ''))
  if (!t) return null
  // Walk up to the card root rather than guessing a class: the nearest ancestor that also
  // contains the chip row is the card.
  let root = t.parentElement
  while (root && !root.querySelector('[data-testid="case-origin"]')) root = root.parentElement
  return {
    origin: root?.querySelector('[data-testid="case-origin"]')?.textContent ?? null,
    count: root?.querySelector('[data-testid="case-review-count"]')?.textContent ?? null
  }
})()`)
check('the routine case card is marked Routine', card?.origin === 'Routine', card)
check(
  'the routine case card shows its unreviewed count',
  /1 to review/.test(card?.count ?? ''),
  card?.count
)

// The reload re-mounted the store; the inbox must still be there, since the run is unreviewed.
check('the inbox survives a reload while the run is unreviewed', (await inboxText()) !== null)

// --- 4. the count is the SQL count ---
const payload1 = await main.evalJs(`window.argus.routines.list()`)
check(
  'unreviewedCount tracks the finished run',
  payload1.unreviewedCount === 1,
  payload1.unreviewedCount
)
check(
  'the run is recorded unreviewed',
  payload1.runs.some((r) => r.routineId === ROUTINE && r.reviewedAt === null)
)
check(
  'the run finished cleanly',
  payload1.runs.find((r) => r.routineId === ROUTINE)?.status === 'ok',
  payload1.runs.find((r) => r.routineId === ROUTINE)?.status
)

// --- 5. Mark reviewed clears it, everywhere ---
const clicked = await main.evalJs(`(() => {
  const e = ${INBOX}
  if (!e) return false
  const b = [...e.querySelectorAll('button')].find((x) => /^Mark reviewed/.test(x.getAttribute('aria-label') || x.textContent || ''))
  if (!b) return false
  b.click()
  return true
})()`)
check('the inbox row offers Mark reviewed', clicked)

await waitFor('the inbox to clear', async () => (await inboxText()) === null, 20000)
check('Mark reviewed removes the section once nothing is left', (await inboxText()) === null)

const payload2 = await main.evalJs(`window.argus.routines.list()`)
check(
  'the run is now recorded reviewed',
  payload2.runs.find((r) => r.routineId === ROUTINE)?.reviewedAt !== null
)
check('unreviewedCount is back to zero', payload2.unreviewedCount === 0, payload2.unreviewedCount)

report()
