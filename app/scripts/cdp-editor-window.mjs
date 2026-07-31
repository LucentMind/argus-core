#!/usr/bin/env node
/**
 * Editor-window shell runtime gate (spec §8.3 steps 1-2, §3.4).
 *
 * jsdom has no window manager: no vitest assertion can see whether a *second* BrowserWindow
 * actually opens, loads editor.html, renders the asset, and dies with its parent. This drives
 * the real app over CDP and checks exactly those things. Two bugs fixed during this increment
 * were invisible to the unit suite and only observable here: main dropping its first
 * `editor:open-tab` before the renderer had loaded, and the renderer subscribing too late to
 * catch main's flush. If either regresses, assertion 3 goes red — the window opens empty.
 *
 * Usage:
 *   1. Prepare a scratch ARGUS_HOME containing at least one USER-tier skill
 *      (<home>/skills-user/<name>/SKILL.md) — the Library only renders an Edit button for
 *      tier === 'user'. Seeding config/settings.json with onboarding.completedAt set keeps the
 *      first-run wizard from covering the Library.
 *   2. Boot the app against it with a debug port, either
 *        ARGUS_HOME=<scratch> npx electron-vite dev --remoteDebuggingPort 9223
 *      or, to exercise the packaged `loadFile(editor.html)` branch instead of the dev-server
 *      URL branch,
 *        ARGUS_HOME=<scratch> dist/win-unpacked/argus.exe --remote-debugging-port=9223
 *   3. node scripts/cdp-editor-window.mjs
 *
 * Env: CDP_PORT (default 9223).
 * Exits 0 when every assertion passes, 1 otherwise.
 *
 * Assertion 5 is destructive by design: it closes the main window and expects the whole app to
 * quit (spec §3.4, the editor is a dependent child, not a peer). It must stay last, and the app
 * has to be re-booted before any further probing.
 *
 * Node 22 has a global `WebSocket` and `fetch`; no dependency is installed for this.
 */
import { listTargets as list, connect, sleep, waitFor, check, report } from './lib/cdp.mjs'

const PORT = process.env.CDP_PORT || '9223'
const listTargets = () => list(PORT)

/** The Library lives behind the settings gear. Poll-and-reclick rather than clicking once: the
 *  settings payload and the skills list both load async, and a single click can land before the
 *  nav exists. Idempotent — clicking a nav entry you are already on is a no-op. */
const gotoLibrary = async (main) => {
  await waitFor(
    'the Library page with a user-tier Edit button',
    async () => {
      if (await main.evalJs(`!!document.querySelector('[aria-label^="Edit \\u00b7 "]')`))
        return true
      await main.evalJs(`(() => {
        const gear = document.querySelector('button[aria-label="Settings"]')
        if (gear && !document.querySelector('nav[aria-label="Settings sections"]')) gear.click()
        const nav = document.querySelector('nav[aria-label="Settings sections"]')
        const lib = nav && [...nav.querySelectorAll('button')]
          .find(b => (b.textContent || '').trim() === 'Library')
        if (lib) lib.click()
        return 1
      })()`)
      return false
    },
    30000
  )
}

// --- 1. main window: navigate to the Library and click the first Edit ---
const before = await listTargets()
check(
  'exactly one window before opening the editor',
  before.length === 1,
  before.map((t) => t.url)
)
if (before.length === 0) {
  throw new Error(`no page target on CDP port ${PORT} — is the app running with a debug port?`)
}

const main = await connect(before[0])
await gotoLibrary(main)
// aria-label is `Edit · <name>` (LibraryPage.tsx) — the middle dot is part of the label, so
// strip it too or the .cm-content lookup below never matches.
const assetLabel = await main.evalJs(
  `document.querySelector('[aria-label^="Edit \\u00b7 "]').getAttribute('aria-label').replace(/^Edit\\s*\\u00b7\\s*/, '')`
)
await main.evalJs(`document.querySelector('[aria-label^="Edit \\u00b7 "]').click()`)

// --- 2. a second target appears, and it is editor.html ---
const editorTarget = await waitFor('a second window', async () => {
  const now = await listTargets()
  return now.find((t) => t.url.includes('editor.html')) ?? null
}).catch(() => null)
check('second window loads editor.html', !!editorTarget, editorTarget?.url)

// --- 3. the editor window renders the asset ---
// CodeSurface labels `.cm-content` `${kind} · ${name}` — this is the assertion that would go red
// if either half of the open-tab handshake regressed (main's flush, or the renderer's
// module-scope subscription): the window would be up but empty.
let editor = null
let rendered = false
if (editorTarget) {
  editor = await connect(editorTarget)
  rendered = await waitFor('the asset to render in the editor window', async () =>
    editor.evalJs(
      `!!document.querySelector('.cm-content[aria-label$=${JSON.stringify('· ' + assetLabel)}]')`
    )
  ).catch(() => false)
}
check('editor window renders the asset', rendered, assetLabel)

// --- 4. a second Edit focuses rather than opening a third window ---
await main.evalJs(`document.querySelector('[aria-label^="Edit \\u00b7 "]').click()`)
await sleep(1500)
const afterSecond = await listTargets()
check(
  'a second Edit does not open a third window',
  afterSecond.filter((t) => t.url.includes('editor.html')).length === 1,
  afterSecond.map((t) => t.url)
)

// --- 5. §3.4: closing the main window takes the editor with it ---
// Poll rather than sleeping a fixed span: `before-quit` races telemetry shutdown against a 3s
// timeout, so the process can outlive the last window by a few seconds. The endpoint refusing
// connections is the observable proof the whole app went away, not just the window.
//
// Require CONSECUTIVE refusals, not one: a single transient loopback connect failure would
// otherwise certify a quit that never happened, and this is the only assertion covering the
// dependent-child rule. An empty target list still does NOT count — the endpoint answering at
// all proves the process is alive, so that resets the streak.
const REQUIRED_REFUSALS = 3
await main.evalJs(`window.close()`)
let quit = false
let refusals = 0
const quitDeadline = Date.now() + 20000
while (Date.now() < quitDeadline) {
  try {
    await listTargets()
    refusals = 0
  } catch {
    refusals += 1
    if (refusals >= REQUIRED_REFUSALS) {
      quit = true
      break
    }
  }
  await sleep(500)
}
check('closing the main window quits the app', quit, { refusals, required: REQUIRED_REFUSALS })

editor?.close()
main.close()
report()
