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
import { execFileSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { dirname, resolve as resolvePath } from 'node:path'
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

// This file lives at <worktree>/app/scripts/cdp-diagnostics.mjs — two levels up from its
// own location is the worktree root, derived rather than hardcoded so the check is correct
// under any worktree's path.
const WORKTREE_ROOT = resolvePath(dirname(fileURLToPath(import.meta.url)), '..', '..')

/**
 * Run a PowerShell one-liner and return trimmed stdout, or null if the shell itself
 * could not be spawned (missing binary, etc). The script text uses a `NOMATCH` sentinel
 * with an explicit try/catch so a "no such process/connection" result is a clean string
 * on stdout with exit 0 — not a thrown error we'd otherwise have to disambiguate from a
 * genuine failure to run PowerShell at all.
 */
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
      // lsof exits 1 with empty stdout both when nothing matches and on some other
      // failures; either way we cannot positively resolve a PID, so fall through.
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
 * Finding 1 (task 10 review, round 1): the gate used to verify only that *some* CDP
 * endpoint answered with *some* page target, never that it was reached THIS worktree's
 * app. Two worktrees both running `electron-vite dev --remoteDebuggingPort 9223`: the
 * second one fails to bind the port — its app runs with no debugging — and the old
 * version of this script then silently validated the FIRST worktree's app. Green gate,
 * untested code.
 *
 * A substring match on the worktree root, not an exact executable match: the process
 * actually holding the port is commonly an `electron.exe` nested under this worktree's
 * `node_modules`, not the `electron-vite` main process, and matching the full absolute
 * path is exactly the granularity that tells worktrees apart.
 *
 * Mismatch is the one outcome that must never pass silently, so it's the one case that
 * hard-fails. Every other outcome (unsupported platform, missing tool, a PID we can't
 * resolve a command line for) prints a loud warning and PROCEEDS — an inability to check
 * ownership is not evidence of a wrong worktree, and hard-failing on it would make this
 * gate unusable on a platform or in an environment we didn't anticipate.
 */
function verifyPortOwnership(port) {
  const plat = process.platform
  if (plat !== 'win32' && plat !== 'darwin' && plat !== 'linux') {
    console.error(
      `WARNING: cannot verify CDP port ${port} ownership on unsupported platform "${plat}" — proceeding unchecked.`
    )
    return
  }
  const pid = resolveListeningPid(port)
  if (pid === null) {
    // Also the "nothing is listening yet" case, which the endpoint check right below
    // reports clearly on its own — no need to editorialize here.
    return
  }
  const cmdLine = resolveCommandLine(pid)
  if (!cmdLine) {
    console.error(
      `WARNING: found PID ${pid} listening on port ${port} but could not resolve its command line — proceeding without ownership verification.`
    )
    return
  }
  const matches =
    plat === 'win32'
      ? cmdLine.toLowerCase().includes(WORKTREE_ROOT.toLowerCase())
      : cmdLine.includes(WORKTREE_ROOT)
  if (!matches) {
    console.error(`Port ${port} is answering, but not from this worktree.`)
    console.error(`  Expected worktree: ${WORKTREE_ROOT}`)
    console.error(`  Actual process (PID ${pid}): ${cmdLine}`)
    console.error(
      'Another worktree is almost certainly holding this port. Free it, or run the app under test with a different --remoteDebuggingPort.'
    )
    process.exit(1)
  }
}

verifyPortOwnership(PORT)

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

// waitFor returns as soon as its predicate yields anything truthy, and `readTile`'s
// return value is a *string*. The service now publishes a snapshot on start() with an
// empty tree and a zeroed footprint, so `diag-procs` legitimately reads "0" in the
// window before the first real sample lands — and the string "0" is truthy. A predicate
// that just returned `readTile('diag-procs')` would accept that pre-sample zero and
// return immediately, which is exactly what produced a spurious failure on a run that
// happened to sample 12s after launch while the real service was healthy the whole
// time. Wait for the condition that actually matters — a parsed count of at least
// 2 — and return null/undefined until it holds, so waitFor keeps polling and its 20s
// timeout (with a label that says what it was waiting for) is the failure mode.
const procs = await waitFor('process count to reach at least 2', async () => {
  const n = Number.parseInt(String(await readTile('diag-procs')).trim(), 10)
  return Number.isFinite(n) && n >= 2 ? n : null
})
check('process count is at least 2', procs >= 2, procs)

// `tbody tr` alone is document-wide (Finding 2, task 10 review, round 1): a table added
// anywhere else on the Settings page would silently inflate this count and could
// false-pass. DiagnosticsSettings.tsx puts no data-testid on the table itself (it is an
// already-reviewed file this script must not touch), so scope by walking up to the
// ancestor <section> and matching on its heading text instead — "Process tree" is unique
// to this section; the Footprint section's copy never uses that exact phrase.
const rows = await conn.evalJs(`(() => {
  const table = [...document.querySelectorAll('table')].find((t) =>
    (t.closest('section')?.textContent || '').includes('Process tree')
  )
  return table ? table.querySelectorAll('tbody tr').length : -1
})()`)
check('tree has a row for every counted process', rows >= procs, { rows, procs })

// Objects and the footprint are read in ONE evalJs. Reading them in two round
// trips would let a 1s tick land between them and produce a spurious mismatch —
// React renders a whole snapshot atomically, so a single synchronous read is
// guaranteed to see one consistent sample.
const recon = await waitFor('objects section to render with real data', async () => {
  const r = await conn.evalJs(`(() => {
    const tile = document.querySelector('[data-testid="diag-procs"]')
    const rows = [...document.querySelectorAll('[data-testid="diag-object-row"]')].map((tr) => ({
      kind: tr.getAttribute('data-kind'),
      procs: Number(tr.getAttribute('data-procs'))
    }))
    if (!tile || rows.length === 0) return null
    return { footprint: Number.parseInt(tile.textContent.trim(), 10), rows }
  })()`)
  return r && r.rows.length > 0 ? r : null
})

check('objects section has rows', recon.rows.length > 0, recon.rows.length)

// The whole point of tier B and C. If this fails, every process fell through to
// Unattributed and the labeling is not working against real data, however green
// the unit tests are.
check(
  'at least one row is attributed to a real Argus object',
  recon.rows.some((r) => r.kind !== 'unattributed'),
  recon.rows.map((r) => r.kind)
)

// The partition invariant, against live data rather than fixtures.
const rowProcs = recon.rows.reduce((t, r) => t + r.procs, 0)
check('objects reconcile with the footprint process count', rowProcs === recon.footprint, {
  rowProcs,
  footprint: recon.footprint,
  rows: recon.rows
})

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
