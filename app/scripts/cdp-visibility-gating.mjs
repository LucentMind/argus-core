#!/usr/bin/env node
/**
 * Visibility-gating runtime gate
 * (spec argus-docs/superpowers/specs/2026-08-01-pr-status-visibility-gating-design.md).
 *
 * `usePrStatuses` suspends its poll on `visibilitychange` and refreshes on `focus`. The unit
 * suite dispatches BOTH of those events itself under jsdom, so it proves the hook reacts
 * correctly and proves nothing whatsoever about whether Electron on Windows actually fires them
 * when a window is minimised and restored. That assumption is load-bearing for the entire
 * feature: if minimising does not flip `visibilityState`, the poll never suspends and the suite
 * stays green anyway.
 *
 * This gate answers only that question, against the real app:
 *   1. a freshly booted window reports `visible`
 *   2. minimising fires `visibilitychange` and flips `visibilityState` to `hidden`
 *   3. restoring fires `visibilitychange` back to `visible`
 *   4. restoring also fires `focus` — the case the 1s debounce exists to coalesce
 *
 * Assertion 4 is the one that justifies RETURN_REFRESH_DEBOUNCE_MS. If a restore turns out to
 * fire only ONE of the two events on this platform, the debounce is dead weight rather than
 * wrong, and the spec's rule 3 should say so.
 *
 * Usage:
 *   1. ARGUS_HOME=<scratch> npx electron-vite dev --remoteDebuggingPort 9223
 *   2. node scripts/cdp-visibility-gating.mjs
 *
 * Env: CDP_PORT (default 9223).
 * Exits 0 when every assertion passes, 1 otherwise.
 */
import { execFileSync } from 'node:child_process'
import { writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  listTargets as list,
  connect,
  sleep,
  waitFor,
  check,
  report,
  mainWindow
} from './lib/cdp.mjs'

const PORT = process.env.CDP_PORT || '9223'

const targets = await list(PORT)
if (targets.length === 0) {
  throw new Error(`no page target on CDP port ${PORT} — is the app running with a debug port?`)
}
const main = await connect(mainWindow(targets) ?? targets[0])

/**
 * Reload before instrumenting, so a re-run starts from a page with no listeners on it.
 *
 * Without this the gate silently lies about EVENT COUNTS: listeners installed by a previous run
 * survive in the page and keep pushing to whatever `window.__visLog` currently points at, so a
 * second run reports every event twice and a third reports it three times. That reads exactly
 * like "Electron fires visibilitychange twice per transition" — a real-looking platform finding
 * invented entirely by the harness. Observed on the first run of this gate.
 */
await main.send('Page.enable')
await main.send('Page.reload', {})
await waitFor(
  'the reloaded page',
  async () => {
    try {
      return (await main.evalJs('document.readyState')) === 'complete'
    } catch {
      return false // navigation tears down the execution context mid-flight
    }
  },
  30000
)

/**
 * Record events as the page sees them, rather than sampling `visibilityState` after the fact.
 * Sampling cannot distinguish "the state changed" from "the event fired": the hook is driven by
 * the EVENT, so a state that flips without notifying would leave the poll running and still look
 * correct to a poll-based probe.
 */
await main.evalJs(`(() => {
  window.__visLog = []
  if (window.__visInstalled) return 1 // belt-and-braces if the reload above ever regresses
  window.__visInstalled = true
  const push = (kind) => window.__visLog.push([kind, document.visibilityState])
  document.addEventListener('visibilitychange', () => push('visibilitychange'))
  window.addEventListener('focus', () => push('focus'))
  window.addEventListener('blur', () => push('blur'))
  return 1
})()`)

const readLog = () => main.evalJs('window.__visLog')
const clearLog = () => main.evalJs('window.__visLog = []')

// --- 1. baseline ---
const initial = await main.evalJs('document.visibilityState')
check('a booted window reports visible', initial === 'visible', initial)

/**
 * Minimise/restore the real OS window.
 *
 * Not CDP: Electron does not implement the `Browser` domain (`Browser.getWindowForTarget` comes
 * back empty), and the app uses native Windows overlay controls (`titleBarOverlay`), so there is
 * no DOM button to click either — the minimise affordance is drawn by the OS, outside the page.
 *
 * Win32 `ShowWindow` is what a real minimise does, which is the point: the whole question is
 * whether the OS-level transition reaches the page as an event.
 *
 * The window is matched on TITLE as well as handle, because Electron spawns several `electron.exe`
 * processes and only one owns a window — and a stray Electron app from another checkout would
 * otherwise be minimised instead, which presents as "the event never fired".
 */
const PS = join(tmpdir(), 'argus-win-window-state.ps1')
writeFileSync(
  PS,
  `param([Parameter(Mandatory=$true)][int]$Cmd)
Add-Type @"
using System;
using System.Runtime.InteropServices;
public class W {
  [DllImport("user32.dll")] public static extern bool ShowWindow(IntPtr h, int n);
  [DllImport("user32.dll")] public static extern bool SetForegroundWindow(IntPtr h);
}
"@
$p = Get-Process electron -ErrorAction SilentlyContinue | Where-Object { $_.MainWindowTitle -eq 'Argus' }
if (-not $p) { Write-Error 'no electron process with an Argus window'; exit 1 }
[void][W]::ShowWindow($p.MainWindowHandle, $Cmd)
if ($Cmd -eq 9) { [void][W]::SetForegroundWindow($p.MainWindowHandle) }
exit 0
`,
  'utf8'
)

const SW_MINIMIZE = 6
const SW_RESTORE = 9
const setWindowState = (state) => {
  execFileSync(
    'powershell.exe',
    ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', PS, '-Cmd', String(state)],
    { stdio: 'pipe' }
  )
}

// --- 2. minimise ---
await clearLog()
let minimiseError = null
try {
  setWindowState(SW_MINIMIZE)
} catch (e) {
  minimiseError = e.message
}
await sleep(1500)

const afterMinimise = await readLog()
const afterMinimiseState = await main.evalJs('document.visibilityState')

check(
  'minimising fires visibilitychange',
  !minimiseError && afterMinimise.some(([kind]) => kind === 'visibilitychange'),
  { error: minimiseError, log: afterMinimise }
)
check(
  'minimising flips visibilityState to hidden',
  afterMinimiseState === 'hidden',
  afterMinimiseState
)

// --- 3 & 4. restore ---
await clearLog()
setWindowState(SW_RESTORE)
// Poll rather than sleeping once: the window manager animates the restore, and `focus` can
// arrive a beat after `visibilitychange`. Waiting for BOTH is the point of assertion 4, so a
// fixed sleep that ended between them would report a false negative.
await waitFor(
  'the restored window to report visible',
  async () => (await main.evalJs('document.visibilityState')) === 'visible',
  15000
).catch(() => null)
await sleep(1500)

const afterRestore = await readLog()
const afterRestoreState = await main.evalJs('document.visibilityState')

check(
  'restoring flips visibilityState back to visible',
  afterRestoreState === 'visible',
  afterRestoreState
)
check(
  'restoring fires visibilitychange',
  afterRestore.some(([kind, state]) => kind === 'visibilitychange' && state === 'visible'),
  afterRestore
)
check(
  'restoring also fires focus (the pair the debounce coalesces)',
  afterRestore.some(([kind]) => kind === 'focus'),
  afterRestore
)

main.close()
report()
