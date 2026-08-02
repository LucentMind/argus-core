#!/usr/bin/env node
/**
 * Diagnostics page runtime gate (plan 2026-08-01-diagnostics-1-pipe.md, task 10).
 *
 * jsdom loads no stylesheet, spawns no sidecar and streams no IPC, so the renderer
 * suite cannot tell a working page from a frozen one. This drives the real app.
 *
 * Usage:
 *   1. ARGUS_HOME=/tmp/argus-diag npx electron-vite dev --remoteDebuggingPort 9223
 *   2. node scripts/cdp-diagnostics.mjs
 *
 * Env: CDP_PORT (default 9223). Exits 0 when every check passes, 1 otherwise.
 */
import {
  listTargets as list,
  connect,
  mainWindow,
  sleep,
  waitFor,
  check,
  report
} from './lib/cdp.mjs'

const PORT = process.env.CDP_PORT || '9223'

// Concurrent worktree sessions collide on 9223. The loser binds nothing and silently
// drives ANOTHER branch's app, which presents as inexplicable assertion failures.
// Fail loudly instead of guessing.
let targets
try {
  targets = await list(PORT)
} catch {
  console.error(`No CDP endpoint on ${PORT}. Start the app with --remoteDebuggingPort ${PORT}.`)
  process.exit(1)
}
if (targets.length === 0) {
  console.error(`Port ${PORT} answered but exposed no page target — is another app holding it?`)
  process.exit(1)
}

const target = mainWindow(targets)
if (!target) {
  console.error('No main window target found (only an editor window?).')
  process.exit(1)
}
const conn = await connect(target)

const clickSelector = (sel) =>
  conn.evalJs(`(() => {
    const el = document.querySelector(${JSON.stringify(sel)})
    if (!el) return false
    el.click()
    return true
  })()`)

const clickByLabel = (containerSel, label) =>
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

// Navigate to Settings -> Diagnostics through the UI, the way a user would. Follows
// cdp-light-theme.mjs's openSettings/gotoSettingsPage pattern (its settings nav is
// [data-testid="dynamic-settings"] once open, and each page confirms itself via
// [data-testid="settings-title"] equalling the page label) rather than the brief's
// generic "click any button whose text matches /settings/i" heuristic, which is more
// likely to hit an unrelated control before the nav has even rendered.
const openSettings = async () => {
  if (await conn.evalJs(`!!document.querySelector('[data-testid="dynamic-settings"]')`)) return
  await clickSelector('button[aria-label="Settings"]')
  await waitFor('settings view', () =>
    conn.evalJs(`!!document.querySelector('[data-testid="dynamic-settings"]')`)
  )
}

const gotoSettingsPage = async (label) => {
  await openSettings()
  await clickByLabel('nav[aria-label="Settings sections"]', label)
  await waitFor(`${label} settings page`, () =>
    conn.evalJs(
      `document.querySelector('[data-testid="settings-title"]')?.textContent === ${JSON.stringify(label)}`
    )
  )
}

await gotoSettingsPage('Diagnostics')

const readTile = (id) =>
  conn.evalJs(
    `(() => { const e = document.querySelector('[data-testid=${JSON.stringify(id)}]'); return e ? e.textContent : null })()`
  )

const procsText = await waitFor(
  'the first sample to arrive',
  async () => await readTile('diag-procs')
)
const procs = Number.parseInt(String(procsText).trim(), 10)
check('process count is at least 2', procs >= 2, procs)

const rows = await conn.evalJs(`document.querySelectorAll('tbody tr').length`)
check('tree has a row for every counted process', rows >= procs, { rows, procs })

// A page that renders once and then freezes passes every static assertion above.
// readAt is monotonic per push, so a strict increase is the one check that tells
// a live stream from a frozen first render.
const readAtBefore = Number(await readTile('diag-readat'))
await sleep(5_000)
const readAtAfter = Number(await readTile('diag-readat'))
check('samples keep streaming (readAt advanced)', readAtAfter > readAtBefore, {
  readAtBefore,
  readAtAfter,
  deltaMs: readAtAfter - readAtBefore
})

// At the 1s fast-tier cadence, five seconds should yield several samples. One or
// two would mean the page is subscribed but the cadence never switched to fast.
check('fast tier is active while the page is open', readAtAfter - readAtBefore >= 3_000, {
  deltaMs: readAtAfter - readAtBefore
})

check(
  'no sidecar-unavailable banner',
  !(await conn.evalJs(`/child-process attribution is unavailable/i.test(document.body.innerText)`))
)

conn.close()
report()
