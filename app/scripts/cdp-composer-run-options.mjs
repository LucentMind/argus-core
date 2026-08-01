#!/usr/bin/env node
/**
 * CDP acceptance for Task 15 — the composer's responsive run-option row (spec's
 * composer-run-options feature). The claim under test is a *layout* claim: at a wide chat
 * pane, Reasoning/Context Window/Fast Mode/Thinking render fused into ONE "Traits" chip
 * (`TraitsChip` in OptionsMenu.tsx — replaced the old one-chip-per-descriptor design) next to
 * Access/Tool results, and once the row's own measured width drops below `COLLAPSE_AT_PX`
 * (650px, see `Composer.tsx`) everything but Model and Send collapses into a single "More
 * options" menu — driven by a live `ResizeObserver` on the row (`useDensity` in Composer.tsx).
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
 * state, so if the Traits chip's joined label still includes "Ultracode" after a reload, the
 * selection lived in the session row, not in a React state variable that only looked persisted.
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

/** What `composer-run-options-fixture.mjs` pins the seeded session to (a WIRE slug). */
const PINNED_MODEL = 'claude-sonnet-5'
/**
 * The one display name that legitimately means `claude-sonnet-5`. Before the model-picker
 * naming fix this differed by catalog source — the live CLI's alias row `sonnet` showed its
 * terse raw `displayName` ("Sonnet"), while the offline STATIC_FALLBACK (catalog.ts) showed
 * `claude-sonnet-5` / "Claude Sonnet 5" — so this list used to accept both. `catalogModelRows`
 * (shared/drivers.ts) now derives every runtime-catalog row's name from its `resolvedModel`
 * against the same static `CLAUDE_MODELS` table STATIC_FALLBACK's names already came from, so
 * the live and offline paths converge on the identical string; a lingering "Sonnet" here would
 * mean that convergence broke. Anything else — most importantly "Default (recommended)", the
 * first row of a real catalog — means the composer resolved the pinned model to the WRONG row.
 * That is exactly what happened before: this gate passed while the chip named a model the
 * session was not pinned to, and every run option was being dropped on the wire, because it
 * never looked at the chip.
 */
const MODEL_CHIP_OK = ['Claude Sonnet 5']

/** The instance the fixture pins its session to (`composer-run-options-fixture.mjs`). */
const INSTANCE_ID = 'claude-default'

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
  // — that first spawn can take several seconds. Wait for the Traits chip rather than a
  // fixed sleep, since it exists only once descriptorsFor() has real data to build from.
  await waitFor(
    'Traits chip to render (model catalog resolved)',
    () => conn.evalJs(`!!document.querySelector('button[title="Traits"]')`),
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
      traitsChip: !!document.querySelector('button[title="Traits"]'),
      moreOptions: !!document.querySelector('[aria-label="More options"]')
    }
  })()`)

/** The wide Traits chip's own displayed text (its joined trigger label), or null if it isn't
 *  mounted (i.e. the row is currently narrow). */
const traitsLabel = () =>
  conn.evalJs(`(() => {
    const btn = document.querySelector('button[title="Traits"]')
    return btn ? btn.textContent.trim() : null
  })()`)

/** Section headings inside an open menu, matched by the class pair `OptionSection` (and
 *  `CollapsedMenu`'s own hand-written Access/Tool results headers) share — see the "4."
 *  check below, which uses the identical selector against the narrow collapsed menu. */
const sectionHeadings = (menuSelector) =>
  conn.evalJs(`(() => {
    const menu = document.querySelector(${JSON.stringify(menuSelector)})
    if (!menu) return []
    return [...menu.querySelectorAll('div.font-medium.text-mute')].map((d) => d.textContent.trim())
  })()`)

/** The Model chip's own displayed text. Survives both densities — the Model chip is one of
 *  the two controls the collapse never folds away. */
const modelLabel = () =>
  conn.evalJs(`(() => {
    const btn = document.querySelector('button[title="Model"]')
    return btn ? btn.textContent.trim() : null
  })()`)

/** The raw runtime catalog for the fixture's instance, straight from the same IPC call
 *  Composer.tsx's `useModelCatalog` makes — not inferred from a chip label. */
const fetchCatalog = () =>
  conn.evalJs(`window.argus.models.catalog(${JSON.stringify(INSTANCE_ID)})`)

// ── boot: wide viewport, fresh load, confirm this is the right app ────────────────────────

await setViewport(1600, 900)
await reload()
await identityGate()
await openCase()

// ── 0. the model chip names the model the session is actually pinned to ───────────────────
//
// This gate used to have nothing to say about the model chip, which is how a Critical defect
// reached final review with fourteen green task reviews behind it: the runtime catalog keys
// rows by CLI alias (`sonnet`), the session is pinned by wire slug (`claude-sonnet-5`), the
// composer compared the two directly, never matched, and fell through to `models[0]` — so
// EVERY chat displayed "Default (recommended)" while the main process independently resolved
// a different row (or none) and silently dropped every run option off the wire.
//
// Note that check 2 below now depends on this too: the Reasoning/Context chips are built from
// the descriptors of the model the session is pinned to, so their mere presence only means
// something once the chip is proven to name the right model.

{
  const label = await modelLabel()
  check(
    `0. the model chip names the pinned model (${PINNED_MODEL}), not catalog row 0`,
    MODEL_CHIP_OK.includes(label),
    { label, accepted: MODEL_CHIP_OK, pinned: PINNED_MODEL }
  )
}

// ── 1. the catalog just exercised is the LIVE runtime catalog, not the offline fallback ────
//
// Check 0's MODEL_CHIP_OK accepts BOTH "Sonnet" (the live alias row's display name) and
// "Claude Sonnet 5" (catalog.ts's STATIC_FALLBACK's) — deliberately, since the fixture is
// built to render its chips identically either way (see composer-run-options-fixture.mjs's own
// doc comment). That means check 0 alone cannot tell a real CLI run from an offline one: run
// this gate with no CLI reachable and check 0 (and check 1's chip presence — STATIC_FALLBACK's
// claude-sonnet-5 row also reports `supportsEffort`) would go green having exercised NOTHING
// about alias↔slug resolution, which is the exact defect this whole gate exists to catch (see
// check 0's comment above).
//
// So ask the same IPC the composer calls (`window.argus.models.catalog`) directly and check
// the SHAPE of what came back: the live catalog is alias-keyed and carries a separate
// `resolvedModel` on every row (catalog.ts's real fetchCatalog path); STATIC_FALLBACK's rows
// are keyed by wire slug directly and carry no `resolvedModel` at all (see catalog.ts's own
// doc comment on the shape difference). A row with `resolvedModel` set is therefore proof the
// live path ran. If this fails, the machine driving this gate could not reach the Claude CLI —
// fix that and re-run; do not loosen this check to make an offline run pass.

{
  const rows = await fetchCatalog()
  const live = Array.isArray(rows) && rows.some((r) => typeof r?.resolvedModel === 'string')
  check(
    '1. the runtime catalog is LIVE (has resolvedModel rows), not catalog.ts STATIC_FALLBACK',
    live,
    { rowCount: Array.isArray(rows) ? rows.length : null, rows }
  )
}

// ── 2. wide composer: density=wide, the fused Traits chip is present ──────────────────────
//
// Re-expressed from the old per-descriptor design (Reasoning + Context Window chips both
// present) to the fused one: there is now exactly ONE chip for every descriptor together.

{
  const wide = await readRow()
  check(
    '2. wide composer: data-composer-density=wide, Traits chip present',
    wide.density === 'wide' && wide.traitsChip,
    wide
  )
}

// ── 2b. opening the wide Traits chip's own popup shows the Reasoning + Context Window
//        sections — proves the fused chip still carries the same per-descriptor controls the
//        old individual chips did, just inside one popup instead of two separate ones ───────

await conn.evalJs(`(() => {
  document.querySelector('button[title="Traits"]').click()
  return true
})()`)
await waitFor('Traits menu to open', () =>
  conn.evalJs(`!!document.querySelector('[role="menu"][aria-label="Traits"]')`)
)

{
  const traitsHeadings = await sectionHeadings('[role="menu"][aria-label="Traits"]')
  check(
    '2b. the wide Traits chip popup shows Reasoning and Context Window sections',
    ['Reasoning', 'Context Window'].every((h) => traitsHeadings.includes(h)),
    traitsHeadings
  )
}

// close the popup (outside click) before narrowing, so it doesn't linger unmounted-but-open
// across the viewport change below.
await conn.evalJs(`(() => {
  const scrim = document.querySelector('.fixed.inset-0')
  if (scrim) scrim.click()
  return true
})()`)

// ── 3. narrow the chat pane (<650px row) and confirm the flip ─────────────────────────────
//
// The row's own width, not the window's, is what the component measures (`useDensity`
// observes `rowRef`, COLLAPSE_AT_PX = 650 — lowered from the old 700 now that the row holds
// one fused Traits chip instead of up to four separate descriptor chips, see Composer.tsx's
// own docstring on the constant). Rather than compute the exact aside/findings-pane arithmetic
// that would put the row at exactly 650px, this drives the viewport down to a width where
// <main>'s own CSS floor (`CHAT_MIN_WIDTH` = 360px, see uiStore.ts/CaseWorkspace.tsx) is what
// ends up binding — reliable regardless of the evidence/findings panes' current widths, and
// still well under the threshold once the composer's own padding is subtracted.
//
// The generous timeout (default waitFor's 20s is doubled here) is not slack for the app —
// it's slack for THIS environment. See setViewport's doc comment: the DOM is already laid out
// at the new size within milliseconds (confirmed via getBoundingClientRect polling by hand),
// but `useDensity`'s ResizeObserver callback only actually fires once
// `document.visibilityState` flips to `'visible'`, and on this desktop that flip is at the
// mercy of real OS window focus — which this terminal itself competes for. A short timeout
// here does not mean "the feature is broken", only "the window didn't get focus in time".

await setViewport(650, 900)
await waitFor('composer row to narrow', () => readRow().then((r) => r.density === 'narrow'), 45000)

{
  const narrow = await readRow()
  check(
    '3. narrow composer (<650px row): density=narrow, Traits chip gone, "More options" exists',
    narrow.density === 'narrow' &&
      narrow.rowWidth !== null &&
      narrow.rowWidth < 650 &&
      !narrow.traitsChip &&
      narrow.moreOptions,
    narrow
  )
}

// ── 4. opening the collapsed menu shows all four section headings ─────────────────────────

await conn.evalJs(`(() => {
  document.querySelector('[aria-label="More options"]').click()
  return true
})()`)
await waitFor('Session options menu to open', () =>
  conn.evalJs(`!!document.querySelector('[role="menu"][aria-label="Session options"]')`)
)

const headings = await sectionHeadings('[role="menu"][aria-label="Session options"]')

check(
  '4. the collapsed menu shows Reasoning, Context Window, Access and Tool results headings',
  ['Reasoning', 'Context Window', 'Access', 'Tool results'].every((h) => headings.includes(h)),
  headings
)

// ── 5. selecting Ultracode makes the (wide) Traits chip's joined label include "Ultracode" ─
//
// The collapsed menu does NOT auto-close on selecting a descriptor option (only the Access
// and Tool results rows call setOpen(false) — see CollapsedMenu in OptionsMenu.tsx), so the
// popup is still open after this click. Widening back to the wide density afterwards is what
// actually exercises the fused Traits chip's own trigger label — that label only exists as a
// standalone chip in wide density; narrow density never shows it outside the menu.
//
// Re-expressed from the old per-chip design: the wide chip used to be Reasoning's OWN chip,
// so its whole text became "Ultracode" after the pick. Now Reasoning is one of up to four
// values joined into a single label (e.g. "Ultracode · 200k · On"), so the assertion checks
// the joined label CONTAINS "Ultracode" as one of its ` · `-separated parts, not that the
// whole label equals it.

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

const labelAfterSelect = await traitsLabel()
check(
  '5. selecting Ultracode makes the Traits chip label include "Ultracode"',
  clickedUltracode && !!labelAfterSelect && labelAfterSelect.split(' · ').includes('Ultracode'),
  { clickedUltracode, labelAfterSelect }
)

// ── 6. reload — the selection must have persisted to the session row, not just component state ──

await reload()
await identityGate()
await openCase()

const labelAfterReload = await traitsLabel()
check(
  '6. after a reload the Ultracode selection survived (proves it persisted to the session row)',
  !!labelAfterReload && labelAfterReload.split(' · ').includes('Ultracode'),
  labelAfterReload
)

// ── 7. and the model chip still names the pinned model after a full remount ───────────────
//
// Same claim as check 0, but from cold: the resolution happens against a catalog that is
// already cached in the main process by now, which is the state most real sessions open in.

{
  const label = await modelLabel()
  check(
    `7. after a reload the model chip still names ${PINNED_MODEL}`,
    MODEL_CHIP_OK.includes(label),
    { label, accepted: MODEL_CHIP_OK }
  )
}

conn.close()
report()
