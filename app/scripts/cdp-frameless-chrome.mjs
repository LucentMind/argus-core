#!/usr/bin/env node
/**
 * Frameless-chrome runtime gate (spec 2026-07-31-frameless-window-chrome §5).
 *
 * jsdom implements neither `-webkit-app-region` nor `env(titlebar-area-*)`, so the vitest suite
 * cannot see whether any of this works. The load-bearing assertion here is the header's computed
 * `padding-right`: that value can only exceed the 12px fallback if `env(titlebar-area-width)`
 * resolved, which happens only when Electron's titleBarOverlay is actually live. If the overlay
 * silently fails to apply, the padding collapses to 12px and assertion 2 goes red.
 *
 * Dragging the window and clicking the system buttons are OS-level and cannot be driven from
 * here — those stay in the human checklist in the plan.
 *
 * Usage:
 *   1. ARGUS_HOME=<scratch> npx electron-vite dev --remoteDebuggingPort 9223
 *   2. node scripts/cdp-frameless-chrome.mjs
 *
 * Env: CDP_PORT (default 9223).
 * Exits 0 when every assertion passes, 1 otherwise.
 */
import { listTargets as list, connect, waitFor, check, report } from './lib/cdp.mjs'

const PORT = process.env.CDP_PORT || '9223'
const listTargets = () => list(PORT)

/** The 12px fallback both inset terms collapse to when the env() vars are absent. */
const FALLBACK_PX = 12

const targets = await listTargets()
if (targets.length === 0) {
  throw new Error(`no page target on CDP port ${PORT} — is the app running with a debug port?`)
}
const main = await connect(targets[0])

// --- 1. the header is a drag region and its controls opt out ---
// `Array.every` on an empty NodeList is vacuously true, so a header that rendered zero buttons
// (page didn't load, wrong window, etc.) would otherwise pass this check by accident. Require a
// non-zero button count as part of the assertion, and surface the count so a future failure is
// diagnosable instead of a bare `false`.
const regions = await main.evalJs(`(() => {
  const header = document.querySelector('header')
  if (!header) return null
  const buttons = [...header.querySelectorAll('button')]
  return {
    header: header.className.includes('argus-drag'),
    inset: header.className.includes('argus-titlebar-inset'),
    buttonCount: buttons.length,
    controls: buttons.length > 0 && buttons.every(b => b.className.includes('argus-nodrag'))
  }
})()`)
check(
  'the main header is a drag region with opted-out controls',
  !!regions && regions.header && regions.inset && regions.controls,
  regions
)

// --- 2. titleBarOverlay is live: env(titlebar-area-*) resolved ---
// This is the assertion that fails if the overlay never applied. Guard the header lookup: an
// unguarded `getComputedStyle(null)` throws inside the page, which kills the whole script before
// the remaining checks can report — fail cleanly through `check(...)` instead.
const padding = await main.evalJs(`(() => {
  const header = document.querySelector('header')
  if (!header) return null
  const s = getComputedStyle(header)
  return { right: parseFloat(s.paddingRight), left: parseFloat(s.paddingLeft) }
})()`)
check(
  'the header reserves room for the system buttons (env(titlebar-area-*) resolved)',
  !!padding && padding.right > FALLBACK_PX,
  padding ? { ...padding, fallback: FALLBACK_PX } : { header: null, fallback: FALLBACK_PX }
)

// --- 3. nothing in the header sits under the button cluster ---
// Same empty-list trap as assertion 1: filtering into `bad` and checking `bad.length === 0`
// passes on a header with no buttons at all. During a run against the wrong app instance this
// check PASSED on an empty button list while everything around it failed — require a non-zero
// button count so an unrendered header is a FAIL, not a silent pass.
const overlap = await main.evalJs(`(() => {
  const header = document.querySelector('header')
  const limit = header.getBoundingClientRect().width - parseFloat(getComputedStyle(header).paddingRight)
  const buttons = [...header.querySelectorAll('button')]
  const bad = buttons
    .filter(b => b.getBoundingClientRect().right > limit + 1)
    .map(b => b.getAttribute('aria-label'))
  return { limit, bad, buttonCount: buttons.length }
})()`)
check(
  'no header control extends under the system buttons',
  overlap.buttonCount > 0 && overlap.bad.length === 0,
  overlap
)

// --- 4. the editor window carries its own strip ---
// The Library's Edit button is how a second window gets opened; see cdp-editor-window.mjs's
// `gotoLibrary` for the navigation this mirrors. A single click block landed against the real
// app before the nav existed and left the app sitting on Settings "General" — the settings
// payload and the skills list both load async. Poll-and-reclick instead: the click moves inside
// the `waitFor` predicate, which returns true as soon as the Edit button exists and otherwise
// re-clicks and returns false. Idempotent — clicking a nav entry you are already on is a no-op.
await waitFor(
  'a user-tier Edit button in the Library',
  async () => {
    if (await main.evalJs(`!!document.querySelector('[aria-label^="Edit \\u00b7 "]')`)) return true
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
await main.evalJs(`document.querySelector('[aria-label^="Edit \\u00b7 "]').click()`)

const editorTarget = await waitFor('the editor window', async () => {
  const now = await listTargets()
  return now.find((t) => t.url.includes('editor.html')) ?? null
}).catch(() => null)

let editorOk = false
let editorPadding = null
if (editorTarget) {
  const editor = await connect(editorTarget)
  editorOk = await waitFor('the editor title strip', async () =>
    editor.evalJs(`!!document.querySelector('.argus-drag.argus-titlebar-inset')`)
  ).catch(() => false)
  editorPadding = await editor.evalJs(`(() => {
    const bar = document.querySelector('.argus-drag.argus-titlebar-inset')
    return bar ? parseFloat(getComputedStyle(bar).paddingRight) : null
  })()`)
  editor.close()
}
check('the editor window renders a drag strip', editorOk, editorTarget?.url)
check(
  'the editor strip reserves room for its system buttons',
  typeof editorPadding === 'number' && editorPadding > FALLBACK_PX,
  { editorPadding, fallback: FALLBACK_PX }
)

main.close()
report()
