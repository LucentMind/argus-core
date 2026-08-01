#!/usr/bin/env node
/**
 * CDP acceptance for Task 15 — the composer's responsive run-option row (spec's
 * composer-run-options feature). The claim under test is a *layout* claim: at a wide chat
 * pane the Reasoning/Context Window/Access/Tool results controls render as individual chips,
 * and once the row's own measured width drops below `COLLAPSE_AT_PX` (560px, see
 * `Composer.tsx`) they collapse into a single "More options" menu — driven by a live
 * `ResizeObserver` on the row (`useDensity` in Composer.tsx).
 *
 * jsdom cannot prove any of this. It loads no stylesheet and resolves no cascade, so
 * `getBoundingClientRect()` on anything in a jsdom-rendered tree is meaningless, and jsdom
 * ships no real `ResizeObserver` at all — Composer.test.tsx stubs one by hand (`StubResizeObserver`)
 * purely to capture the callback so a test can invoke it manually; it never fires from an actual
 * size change, because jsdom never lays anything out. A green unit suite therefore says nothing
 * about whether the row ever actually collapses, whether it collapses at the RIGHT width, or
 * whether the chips it hides in narrow mode are the right ones. This script drives the real
 * app over CDP, resizes the real Chromium viewport, and reads the real computed DOM.
 *
 * It also proves persistence end-to-end: selecting Ultracode calls
 * `window.argus.sessions.setRunOptions`, a real IPC round trip to the main process, which
 * writes `sessions.run_options` in the sqlite db. Reloading the page discards all renderer
 * state, so if the Reasoning chip still reads "Ultracode" after a reload, the selection lived
 * in the session row, not in a React state variable that only looked persisted.
 *
 * Usage:
 *   1. Seed a scratch home (creates <home>, no argus.db yet):
 *        ARGUS_HOME=<home> npm run dev                     # boot once so migrations run, then quit
 *        ARGUS_HOME=<home> node scripts/composer-run-options-fixture.mjs
 *   2. Boot the app against the same home with a debug port:
 *        ARGUS_HOME=<home> npx electron-vite dev --remoteDebuggingPort 9231
 *   3. node scripts/cdp-composer-run-options.mjs
 *
 * Env: CDP_PORT (default 9231).
 * Exits 0 when every check passes, 1 otherwise.
 *
 * Port collision trap (bitten by this before, see the repo's own notes): if the requested
 * debug port is already bound by ANOTHER worktree's dev instance, `electron-vite dev
 * --remoteDebuggingPort N` does not fail loudly — it logs one `bind() returned an error` line
 * among a wall of GPU-cache warnings and carries on with no debug port at all. This script would
 * then happily connect to whichever OTHER Argus instance owns the port and report ITS UI as
 * this feature's. The identity gate below (matching this fixture's case title) is what catches
 * that before anything is measured.
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

const PORT = process.env.CDP_PORT || '9231'
const CASE_TITLE = 'Composer run options fixture'

const conn = await connect(mainWindow(await list(PORT)))

/** Force the page's CSS viewport to an exact size, independent of the actual OS window — same
 *  mechanism regular Chrome DevTools device emulation uses.
 *
 * Also calls `Page.bringToFront`: measured live in this environment, `document.hidden` tracks
 * genuine OS-level window occlusion/focus, and Chromium gates the "update the rendering" step
 * — the same step that delivers `ResizeObserver` callbacks — behind the page being visible.
 * `useDensity` (Composer.tsx) is entirely `ResizeObserver`-driven, so a viewport change made
 * while this window is occluded by something else on the desktop (another app, this very
 * terminal) can sit for seconds with the DOM already laid out at the new size but the
 * component's `density` state not yet caught up — verified directly: an observer attached by
 * hand fired zero times while `document.visibilityState === 'hidden'`, then fired within one
 * poll tick of it flipping to `'visible'`. `bringToFront` does not force that flip on its own
 * (it is a DevTools front-target concept, not real OS window activation), but calling it after
 * every resize costs nothing and helps on some window managers; the real mitigation is the
 * generous timeout on the density-flip `waitFor` calls below rather than a fixed sleep. */
async function setViewport(width, height) {
  const r = await conn.send('Emulation.setDeviceMetricsOverride', {
    width,
    height,
    deviceScaleFactor: 1,
    mobile: false
  })
  if (r.error) throw new Error(`setViewport failed: ${JSON.stringify(r.error)}`)
  await conn.send('Page.bringToFront', {})
}

/** Reload the page, then let React re-mount and the case list re-fetch. */
async function reload() {
  await conn.send('Page.reload', { ignoreCache: true })
  await sleep(3000)
}

/** Refuse to measure anything until this gate's own fixture case is actually on screen — see
 *  the port-collision trap in the module doc comment above. */
async function identityGate() {
  await waitFor('case list to load', () =>
    conn.evalJs(`document.querySelectorAll('[data-testid="case-title"]').length > 0`)
  )
  const titles = await conn.evalJs(`(() => [
    ...document.querySelectorAll('[data-testid="case-title"]')
  ].map((el) => el.textContent.trim()))()`)
  if (!titles.includes(CASE_TITLE)) {
    console.error(
      `\nWRONG APP on port ${PORT}. Expected this gate's fixture case ${JSON.stringify(CASE_TITLE)}; ` +
        `found ${JSON.stringify(titles)}.\n` +
        'Another Argus instance almost certainly owns the port — grep the dev log for "bind() ' +
        'returned an error", pick a free port, and relaunch. Measuring on regardless would ' +
        "report another branch's UI as this one's."
    )
    process.exit(2)
  }
}

/** Click the fixture case open from the home view. */
async function openCase() {
  const clicked = await conn.evalJs(`(() => {
    const h2 = [...document.querySelectorAll('[data-testid="case-title"]')]
      .find((el) => el.textContent.trim() === ${JSON.stringify(CASE_TITLE)})
    if (!h2) return false
    h2.click()
    return true
  })()`)
  if (!clicked) throw new Error(`could not find case card titled ${JSON.stringify(CASE_TITLE)}`)
  await waitFor('composer to mount', () =>
    conn.evalJs(`!!document.querySelector('[data-testid="composer-options"]')`)
  )
  // The model catalog is fetched from the real Claude CLI the first time any case opens in
  // this app instance (catalog.ts's fetchCatalog, cached for the process lifetime after that)
  // — that first spawn can take several seconds. Wait for the Reasoning chip rather than a
  // fixed sleep, since it exists only once descriptorsFor() has real data to build from.
  await waitFor(
    'Reasoning chip to render (model catalog resolved)',
    () => conn.evalJs(`!!document.querySelector('button[title="Reasoning"]')`),
    20000
  )
}

/** The composer's option row: density + which chips are present. */
const readRow = () =>
  conn.evalJs(`(() => {
    const row = document.querySelector('[data-testid="composer-options"]')
    return {
      density: row ? row.getAttribute('data-composer-density') : null,
      rowWidth: row ? Math.round(row.getBoundingClientRect().width) : null,
      reasoningChip: !!document.querySelector('button[title="Reasoning"]'),
      contextChip: !!document.querySelector('button[title="Context Window"]'),
      moreOptions: !!document.querySelector('[aria-label="More options"]')
    }
  })()`)

/** The wide Reasoning chip's own displayed text (its trigger label), or null if it isn't
 *  mounted (i.e. the row is currently narrow). */
const reasoningLabel = () =>
  conn.evalJs(`(() => {
    const btn = document.querySelector('button[title="Reasoning"]')
    return btn ? btn.textContent.trim() : null
  })()`)

// ── boot: wide viewport, fresh load, confirm this is the right app ────────────────────────

await setViewport(1600, 900)
await reload()
await identityGate()
await openCase()

// ── 1. wide composer: density=wide, Reasoning + Context Window chips both present ─────────

{
  const wide = await readRow()
  check(
    '1. wide composer: data-composer-density=wide, Reasoning + Context Window chips present',
    wide.density === 'wide' && wide.reasoningChip && wide.contextChip,
    wide
  )
}

// ── 2. narrow the chat pane (<560px row) and confirm the flip ─────────────────────────────
//
// The row's own width, not the window's, is what the component measures (`useDensity`
// observes `rowRef`, COLLAPSE_AT_PX = 560). Rather than compute the exact aside/findings-pane
// arithmetic that would put the row at exactly 560px, this drives the viewport down to a width
// where <main>'s own CSS floor (`CHAT_MIN_WIDTH` = 360px, see uiStore.ts/CaseWorkspace.tsx)
// is what ends up binding — reliable regardless of the evidence/findings panes' current
// widths, and still well under the threshold once the composer's own padding is subtracted.
//
// The generous timeout (default waitFor's 20s is doubled here) is not slack for the app —
// it's slack for THIS environment. See setViewport's doc comment: the DOM is already laid out
// at the new size within milliseconds (confirmed via getBoundingClientRect polling by hand),
// but `useDensity`'s ResizeObserver callback only actually fires once
// `document.visibilityState` flips to `'visible'`, and on this desktop that flip is at the
// mercy of real OS window focus — which this terminal itself competes for. A short timeout
// here does not mean "the feature is broken", only "the window didn't get focus in time".

await setViewport(700, 900)
await waitFor('composer row to narrow', () => readRow().then((r) => r.density === 'narrow'), 45000)

{
  const narrow = await readRow()
  check(
    '2. narrow composer (<560px row): density=narrow, Reasoning/Context chips gone, "More options" exists',
    narrow.density === 'narrow' &&
      narrow.rowWidth !== null &&
      narrow.rowWidth < 560 &&
      !narrow.reasoningChip &&
      !narrow.contextChip &&
      narrow.moreOptions,
    narrow
  )
}

// ── 3. opening the collapsed menu shows all four section headings ─────────────────────────

await conn.evalJs(`(() => {
  document.querySelector('[aria-label="More options"]').click()
  return true
})()`)
await waitFor('Session options menu to open', () =>
  conn.evalJs(`!!document.querySelector('[role="menu"][aria-label="Session options"]')`)
)

const headings = await conn.evalJs(`(() => {
  const menu = document.querySelector('[role="menu"][aria-label="Session options"]')
  if (!menu) return []
  // The section-heading divs share this exact class pair (OptionsMenu.tsx's OptionSection,
  // and CollapsedMenu's own hand-written Access/Tool results headers) — matched by class
  // rather than by tag so this doesn't also pick up the menu's own wrapper divs.
  return [...menu.querySelectorAll('div.font-medium.text-mute')].map((d) => d.textContent.trim())
})()`)

check(
  '3. the collapsed menu shows Reasoning, Context Window, Access and Tool results headings',
  ['Reasoning', 'Context Window', 'Access', 'Tool results'].every((h) => headings.includes(h)),
  headings
)

// ── 4. selecting Ultracode makes the (wide) Reasoning chip read "Ultracode" ────────────────
//
// The collapsed menu does NOT auto-close on selecting a descriptor option (only the Access
// and Tool results rows call setOpen(false) — see CollapsedMenu in OptionsMenu.tsx), so the
// popup is still open after this click. Widening back to the wide density afterwards is what
// actually exercises "the composer's Reasoning label" the task asks about — that label only
// exists as a standalone chip in wide density; narrow density never shows it outside the menu.

const clickedUltracode = await conn.evalJs(`(() => {
  const menu = document.querySelector('[role="menu"][aria-label="Session options"]')
  const btn = menu && [...menu.querySelectorAll('button[role="menuitem"]')]
    .find((b) => b.textContent.trim() === 'Ultracode')
  if (!btn) return false
  btn.click()
  return true
})()`)
// Let the optimistic session-state update (CaseWorkspace's handleRunOptionsChange) land
// before the viewport change below unmounts the collapsed menu and remounts the wide chips.
await sleep(500)

await setViewport(1600, 900)
// Same OS-visibility caveat as the narrow wait above — see setViewport's doc comment.
await waitFor(
  'composer row to widen back out',
  () => readRow().then((r) => r.density === 'wide'),
  45000
)
await sleep(400)

const labelAfterSelect = await reasoningLabel()
check(
  '4. selecting Ultracode makes the Reasoning chip read "Ultracode"',
  clickedUltracode && labelAfterSelect === 'Ultracode',
  { clickedUltracode, labelAfterSelect }
)

// ── 5. reload — the selection must have persisted to the session row, not just component state ──

await reload()
await identityGate()
await openCase()

const labelAfterReload = await reasoningLabel()
check(
  '5. after a reload the Ultracode selection survived (proves it persisted to the session row)',
  labelAfterReload === 'Ultracode',
  labelAfterReload
)

conn.close()
report()
