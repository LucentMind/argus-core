#!/usr/bin/env node
/**
 * Routines increment 3 — the two assertions that need a process restart.
 *
 * Split from cdp-routines-inbox.mjs because a script cannot relaunch the app it is driving. Run
 * each phase against a freshly booted app:
 *
 *   PHASE=persist   after a normal relaunch, with everything reviewed before the restart
 *   PHASE=reconcile after a relaunch that killed the app MID-RUN
 *
 * Why these two and no others: `reviewed_at` is a column, so persistence across a restart is the
 * only thing that proves the review state is really in the database and not in renderer memory.
 * And `reconcileInterruptedRuns` runs at every boot, turning a run the app died inside of into a
 * `failed` one — the migration deliberately backfills only rows WITH a `finished_at`, so a
 * stranded row must arrive UNREVIEWED and show up in the inbox. "Your overnight run died" is
 * exactly what the inbox exists to say, and nothing in jsdom can produce a killed process.
 *
 * Usage: PHASE=persist node scripts/cdp-routines-relaunch.mjs
 * Env: CDP_PORT (default 9227), ROUTINE_ID (default inbox-gate).
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
const PHASE = process.env.PHASE || 'persist'

const targets = await list(PORT)
if (targets.length === 0) throw new Error(`no page target on CDP port ${PORT}`)
const main = await connect(mainWindow(targets) ?? targets[0])

const INBOX = `document.querySelector('[data-testid="routine-inbox"]')`
const inboxText = () =>
  main.evalJs(`(() => { const e = ${INBOX}; return e ? e.innerText : null })()`)

// The active view is persisted across restarts, and the inbox renders only on Home — so navigate
// and PROVE it, or every DOM assertion below is vacuous. (Learned the hard way: an earlier draft
// reported "no inbox" from the Settings page.)
await main.evalJs(
  `(() => { const b = document.querySelector('[aria-label="All cases"]'); if (b) b.click(); return !!b })()`
)
await waitFor(
  'Home to be on screen',
  async () => await main.evalJs(`!!document.querySelector('h1')`),
  20000
)
check(
  'the gate is actually on Home before asserting about it',
  await main.evalJs(`!!document.querySelector('h1')`)
)

const payload = await main.evalJs(`window.argus.routines.list()`)
const mine = payload.runs.filter((r) => r.routineId === ROUTINE)

if (PHASE === 'persist') {
  check('runs survived the restart', mine.length > 0, mine.length)
  check(
    'every run reviewed before the restart is still reviewed',
    mine.every((r) => r.reviewedAt !== null),
    mine.map((r) => [r.id, r.status, r.reviewedAt])
  )
  check('nothing is waiting to be reviewed', payload.unreviewedCount === 0, payload.unreviewedCount)
  check('the inbox is absent after a clean relaunch', (await inboxText()) === null)
} else if (PHASE === 'reconcile') {
  // The app was killed mid-run. `reconcileInterruptedRuns` runs inside registerIpc at boot,
  // before any handler exists, so by the time we can talk to it the row is already closed out.
  const stranded = mine.find((r) => /Interrupted/i.test(r.error ?? ''))
  check(
    'the run the app died inside of was reconciled to failed',
    stranded?.status === 'failed',
    stranded && [stranded.id, stranded.status, stranded.error]
  )
  check(
    'the reconciled run is UNREVIEWED, so the user is told it died',
    stranded?.reviewedAt === null,
    stranded?.reviewedAt
  )
  check('it is counted', payload.unreviewedCount >= 1, payload.unreviewedCount)

  const text = await inboxText()
  check(
    'it appears in the Home inbox',
    text !== null && /Inbox gate/.test(text),
    text?.slice(0, 240)
  )
  check(
    'the inbox shows the failure, not a silent empty row',
    /failed|Interrupted/i.test(text ?? '')
  )
  check(
    'no run is left stuck in a running state',
    !mine.some((r) => r.status === 'running'),
    mine.map((r) => r.status)
  )
} else {
  throw new Error(`unknown PHASE ${PHASE}`)
}

await sleep(200)
report()
