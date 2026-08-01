#!/usr/bin/env node
/**
 * Frameless-chrome runtime gate (spec 2026-08-01-frameless-chrome-increment-2).
 *
 * WINDOWS-SPECIFIC. The padding-right assertions below (the strip's own inset, and the "nothing
 * extends under the button cluster" checks) assume the OS button cluster sits on the RIGHT. On
 * macOS the traffic lights are on the LEFT — a correct macOS build would fail those checks, not
 * pass them. This gate is not meant to run there; see `.argus-titlebar-inset`'s darwin branch in
 * main.css for the left-side equivalent, which this script does not exercise.
 *
 * jsdom implements neither `-webkit-app-region` nor `env(titlebar-area-*)`, so the vitest suite
 * cannot see whether any of this works. The load-bearing assertion here is the strip's computed
 * `padding-right`: that value can only exceed the 12px fallback if `env(titlebar-area-width)`
 * resolved, which happens only when Electron's titleBarOverlay is actually live. If the overlay
 * silently fails to apply, the padding collapses to 12px and that assertion goes red.
 *
 * The main window's title bar is a bare drag strip (`TitleBarStrip.tsx`, `.argus-drag
 * .argus-titlebar-inset`) above `TopBar`'s `<header>` — as of this increment `<header>` itself no
 * longer carries `argus-titlebar-inset` (dropped along with the reserved padding; see
 * TopBar.tsx's comment), so the env(titlebar-area-*) / overlap assertions target the strip, not
 * the header. `<header>` keeps `argus-drag` and is still checked for its own concern: that its
 * interactive children opt out with `argus-nodrag`.
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
import { listTargets as list, connect, mainWindow, waitFor, check, report } from './lib/cdp.mjs'

const PORT = process.env.CDP_PORT || '9223'
const listTargets = () => list(PORT)

/** The 12px fallback both inset terms collapse to when the env() vars are absent. */
const FALLBACK_PX = 12

/** Unique to `TitleBarStrip.tsx`: `TopBar`'s `<header>` keeps `argus-drag` but dropped
 *  `argus-titlebar-inset` this increment, so this combination no longer matches it too. */
const STRIP = '.argus-drag.argus-titlebar-inset'

// --- 0. exactly one window before the gate starts ---
// The existing gates used `targets[0]`, which is the main window only on a fresh boot: once an
// editor window exists the order is not guaranteed, and picking [0] would silently search the
// EDITOR window for the header/strip — presenting as "the Library never loaded" or a wrongly-red
// assertion. Require a known-clean starting state, mirroring cdp-editor-window.mjs's assertion 1,
// then resolve the main window by content rather than position via `mainWindow()`.
const before = await listTargets()
check(
  'exactly one window before the gate starts',
  before.length === 1,
  before.map((t) => t.url)
)
if (before.length === 0) {
  throw new Error(`no page target on CDP port ${PORT} — is the app running with a debug port?`)
}
const mainTarget = mainWindow(before)
if (!mainTarget) {
  throw new Error(`no main-window target among: ${before.map((t) => t.url).join(', ')}`)
}
const main = await connect(mainTarget)

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
    buttonCount: buttons.length,
    controls: buttons.length > 0 && buttons.every(b => b.className.includes('argus-nodrag'))
  }
})()`)
check(
  'the main header is a drag region with opted-out controls',
  !!regions && regions.header && regions.controls,
  regions
)

// --- 2. the main window renders its own drag strip above the header ---
// Mirrors assertion "the editor window renders a drag strip" below — same component
// (`TitleBarStrip`), same selector, different window.
const strip = await main.evalJs(`(() => {
  const el = document.querySelector(${JSON.stringify(STRIP)})
  if (!el) return null
  return {
    drag: el.className.includes('argus-drag'),
    inset: el.className.includes('argus-titlebar-inset')
  }
})()`)
check('the main window renders its own drag strip', !!strip && strip.drag && strip.inset, strip)

// --- 3. titleBarOverlay is live: env(titlebar-area-*) resolved on the strip ---
// This is the assertion that fails if the overlay never applied. Guard the lookup: an unguarded
// `getComputedStyle(null)` throws inside the page, which kills the whole script before the
// remaining checks can report — fail cleanly through `check(...)` instead.
const padding = await main.evalJs(`(() => {
  const el = document.querySelector(${JSON.stringify(STRIP)})
  if (!el) return null
  const s = getComputedStyle(el)
  return { right: parseFloat(s.paddingRight), left: parseFloat(s.paddingLeft) }
})()`)
check(
  'the strip reserves room for the system buttons (env(titlebar-area-*) resolved)',
  !!padding && padding.right > FALLBACK_PX,
  padding ? { ...padding, fallback: FALLBACK_PX } : { strip: null, fallback: FALLBACK_PX }
)

// --- 4. nothing rendered in the strip sits under the button cluster ---
// The strip is deliberately empty for the main window (no label), so this is a regression guard
// against something later being added to it — not a check that can currently fail for the right
// reason. Guarded the same way as assertion 3, for the same reason.
const overlap = await main.evalJs(`(() => {
  const el = document.querySelector(${JSON.stringify(STRIP)})
  if (!el) return null
  const limit = el.getBoundingClientRect().width - parseFloat(getComputedStyle(el).paddingRight)
  const kids = [...el.children]
  const bad = kids
    .filter(k => k.getBoundingClientRect().right > limit + 1)
    .map(k => k.outerHTML)
  return { limit, bad, childCount: kids.length }
})()`)
check(
  'nothing rendered in the strip extends under the system buttons',
  !!overlap && overlap.bad.length === 0,
  overlap
)

// --- 5. the editor window carries its own strip ---
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
// The element that satisfied the `waitFor` above can be gone by the time this line runs (a
// re-render between the wait resolving and the click landing throws on a null dereference and
// kills the script). Route the click itself through `waitFor` too: each poll re-queries the
// button immediately before clicking it, so a stale reference can't be dereferenced.
await waitFor(
  'the Library Edit button to accept a click',
  () =>
    main.evalJs(`(() => {
    const btn = document.querySelector('[aria-label^="Edit \\u00b7 "]')
    if (!btn) return false
    btn.click()
    return true
  })()`),
  5000
)

const editorTarget = await waitFor('the editor window', async () => {
  const now = await listTargets()
  return now.find((t) => t.url.includes('editor.html')) ?? null
}).catch(() => null)

let editorOk = false
let editorPadding = null
if (editorTarget) {
  const editor = await connect(editorTarget)
  editorOk = await waitFor('the editor title strip', async () =>
    editor.evalJs(`!!document.querySelector(${JSON.stringify(STRIP)})`)
  ).catch(() => false)
  editorPadding = await editor.evalJs(`(() => {
    const bar = document.querySelector(${JSON.stringify(STRIP)})
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
