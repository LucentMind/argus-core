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
 * SCOPE, as of spec 2026-08-01-header-window-controls: this gate is now about the EDITOR window.
 * The main window's bare drag strip is gone — its `<header>` is the title bar and draws its own
 * caption buttons — so the `env(titlebar-area-*)` and overlap assertions that used to target the
 * main strip moved out with it. What remains for the main window is one inverted guard (no strip
 * came back) plus its long-standing drag-region check: `<header>` keeps `argus-drag`, and every
 * interactive child must opt out with `argus-nodrag`. The header's geometry, its caption cluster,
 * and the ambient layer are covered by `cdp-header-window-controls.mjs`.
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

// --- 2. the main window has NO strip of its own any more ---
// It used to render one, and assertions here used to measure its `env(titlebar-area-*)` padding
// to prove the overlay was live. Both are gone with spec 2026-08-01-header-window-controls: the
// main window is built with no `titleBarOverlay` at all on win32/linux (an overlay paints an
// opaque OS-owned rect the ambient flow cannot read through), so there is no overlay to detect
// and no cluster to reserve room for — the header draws its own buttons and IS the title bar.
// Kept as an inverted regression guard so a reintroduced strip fails loudly here rather than
// silently stacking two bars again. The header's own geometry, its caption cluster, and the
// overlay's absence are asserted in `cdp-header-window-controls.mjs`.
const strip = await main.evalJs(`!!document.querySelector(${JSON.stringify(STRIP)})`)
check('the main window renders no strip of its own', strip === false, { strip })

// --- 3. the editor window carries its own strip ---
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
let editorChrome = null
if (editorTarget) {
  const editor = await connect(editorTarget)
  editorOk = await waitFor('the editor title strip', async () =>
    editor.evalJs(`!!document.querySelector(${JSON.stringify(STRIP)})`)
  ).catch(() => false)
  editorPadding = await editor.evalJs(`(() => {
    const bar = document.querySelector(${JSON.stringify(STRIP)})
    return bar ? parseFloat(getComputedStyle(bar).paddingRight) : null
  })()`)
  // The editor window collapsed to ONE row of chrome (user-directed, 2026-08-01): the tab strip
  // and the active pane's Save / view-mode buttons all live in this strip now. Unlike the main
  // window's (assertion 4), it is NOT empty, so the overlap check below can actually fail for the
  // right reason — and the drag-region opt-out matters here in a way jsdom can never see.
  //
  // Waited for, not read once: the pane's buttons arrive by portal only after `AssetTab`'s async
  // resolve lands, which is well after the strip itself exists.
  editorChrome = await waitFor(
    "the editor strip's tabs and pane actions",
    async () => {
      const r = await editor.evalJs(`(() => {
        const el = document.querySelector(${JSON.stringify(STRIP)})
        if (!el) return null
        const limit = el.getBoundingClientRect().width - parseFloat(getComputedStyle(el).paddingRight)
        const interactive = [...el.querySelectorAll('button, [role="tab"], [role="tablist"]')]
        return {
          drag: el.className.includes('argus-drag'),
          tabs: el.querySelectorAll('[role="tab"]').length,
          save: interactive.filter(b => (b.textContent || '').trim() === 'Save').length,
          dragging: interactive.filter(b => !b.closest('.argus-nodrag')).map(b => b.outerHTML),
          underButtons: [...el.children]
            .filter(k => k.getBoundingClientRect().right > limit + 1)
            .map(k => k.outerHTML)
        }
      })()`)
      return r && r.tabs > 0 && r.save > 0 ? r : null
    },
    15000
  ).catch(() => null)
  editor.close()
}
check('the editor window renders a drag strip', editorOk, editorTarget?.url)
check(
  'the editor strip reserves room for its system buttons',
  typeof editorPadding === 'number' && editorPadding > FALLBACK_PX,
  { editorPadding, fallback: FALLBACK_PX }
)
check(
  'the editor strip carries the tabs and exactly one pane action set',
  !!editorChrome && editorChrome.drag && editorChrome.tabs > 0 && editorChrome.save === 1,
  editorChrome
)
check(
  "the editor strip's tabs and buttons opt out of the drag region",
  !!editorChrome && editorChrome.dragging.length === 0,
  editorChrome && { dragging: editorChrome.dragging }
)
check(
  'nothing in the editor strip extends under the system buttons',
  !!editorChrome && editorChrome.underButtons.length === 0,
  editorChrome && { underButtons: editorChrome.underButtons }
)

main.close()
report()
