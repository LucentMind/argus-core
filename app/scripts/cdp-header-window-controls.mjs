#!/usr/bin/env node
/**
 * Header window-controls runtime gate (spec 2026-08-01-header-window-controls-design.md).
 *
 * WINDOWS-SPECIFIC, like its sibling `cdp-frameless-chrome.mjs`: the caption cluster asserted
 * here renders only where `WindowControls` renders, i.e. everywhere except darwin. On macOS the
 * traffic lights are the OS's and this whole cluster is absent by design — a correct macOS build
 * fails these checks rather than passing them.
 *
 * Why this exists: jsdom implements neither `-webkit-app-region`, nor `env(titlebar-area-*)`, nor
 * `position: fixed` stacking, and it returns null from `getContext('webgl2')`. So the entire
 * visible result of this change — buttons in the header, the ambient flow reading through it —
 * is invisible to the vitest suite. Everything below is a fact the unit tests structurally cannot
 * assert.
 *
 * NOT covered here:
 *  - Whether the aurora LOOKS right. This is a taste judgement, not a measurable one, so it stays
 *    a human check. It is NOT that screenshots cannot see the canvas: an earlier draft of this
 *    comment claimed `Page.captureScreenshot` will not composite a WebGL canvas created without
 *    `preserveDrawingBuffer`, and that is simply wrong — a 400x200 capture over the lit region
 *    came back 77KB of real gradient, and `cdp-dynamic-theme-views.mjs` has been sampling aurora
 *    pixels through screenshots all along. A black capture means the shader had nothing to draw
 *    there, which is a finding, not a tooling limit. Pixel-sampling assertions can be added here.
 *  - Dragging the window, and double-click-to-maximize. Both are OS-level. A CDP-synthesised
 *    mouse event bypasses the OS drag handler entirely, so a passing synthetic click would prove
 *    nothing about whether the real drag region swallows it. The `argus-nodrag` assertions below
 *    are the proxy; the gestures stay in the human checklist.
 *
 * Usage:
 *   1. ARGUS_HOME=<scratch> npx electron-vite dev --remoteDebuggingPort 9223
 *   2. node scripts/cdp-header-window-controls.mjs
 *
 * Env: CDP_PORT (default 9223).
 * Exits 0 when every assertion passes, 1 otherwise.
 */
import { listTargets as list, connect, mainWindow, waitFor, check, report } from './lib/cdp.mjs'

const PORT = process.env.CDP_PORT || '9223'
const listTargets = () => list(PORT)

const before = await listTargets()
if (before.length === 0) {
  throw new Error(`no page target on CDP port ${PORT} — is the app running with a debug port?`)
}
const mainTarget = mainWindow(before)
if (!mainTarget) {
  throw new Error(`no main-window target among: ${before.map((t) => t.url).join(', ')}`)
}
const main = await connect(mainTarget)

// --- 1. the main window's own drag strip is gone ---
// Its removal is the whole point: the header is the title bar now. `.argus-titlebar-inset` still
// exists as a class (the editor window uses it), so this asserts absence of the STRIP, not of
// the rule.
const strip = await main.evalJs(`!!document.querySelector('.argus-drag.argus-titlebar-inset')`)
check('the main window no longer renders a title-bar strip', strip === false, { strip })

// --- 2. the header IS the title bar: at the window's top edge, full width ---
const header = await main.evalJs(`(() => {
  const h = document.querySelector('header')
  if (!h) return null
  const r = h.getBoundingClientRect()
  const s = getComputedStyle(h)
  return {
    top: r.top, height: r.height, width: r.width, innerWidth: window.innerWidth,
    drag: h.className.includes('argus-drag'),
    inset: h.className.includes('argus-header-inset'),
    // The strip's class reserves right-hand room for a native cluster it no longer has; taking it
    // here would shove our own buttons ~140px inward on win32. See main.css.
    strayInset: h.className.includes('argus-titlebar-inset'),
    paddingLeft: parseFloat(s.paddingLeft),
    paddingRight: parseFloat(s.paddingRight),
    zIndex: s.zIndex, position: s.position
  }
})()`)
check(
  'the header sits at the window top edge, full width, as a drag region',
  !!header && header.top === 0 && header.width === header.innerWidth && header.drag,
  header
)
check(
  'the header takes the narrow header inset, not the strip inset',
  !!header && header.inset && !header.strayInset && header.paddingRight === 0,
  header && {
    inset: header.inset,
    strayInset: header.strayInset,
    paddingLeft: header.paddingLeft,
    paddingRight: header.paddingRight
  }
)

// --- 3. the caption cluster: three buttons, contiguous, flush into the corner ---
// Contiguity is load-bearing, not cosmetic. As a fragment these were direct flex children of the
// header, so its `gap-1.5` opened a 6px gutter between each — at which point they read as three
// more toolbar icons continuing the gauge/settings/theme row instead of as the window's caption
// cluster. Caught live; no unit test can see it.
const cluster = await main.evalJs(`(() => {
  const bs = [...document.querySelectorAll('[data-testid^="window-"]')]
  if (bs.length === 0) return { count: 0 }
  const r = bs.map(b => b.getBoundingClientRect())
  const h = document.querySelector('header').getBoundingClientRect()
  return {
    count: bs.length,
    ids: bs.map(b => b.dataset.testid),
    nodrag: bs.every(b => b.className.includes('argus-nodrag')),
    gaps: r.slice(1).map((x, i) => Math.round(x.left - r[i].right)),
    flushRight: Math.round(r[r.length - 1].right) === Math.round(window.innerWidth),
    // Every button must fill the header's content box exactly. With the dynamic theme off the
    // header carries a 1px border-b, so a fixed h-12 child centred in the 47px content box sat
    // half a pixel proud of the bar. Also caught live.
    spansHeader: r.every(x => Math.abs(x.top - h.top) < 0.01 && Math.abs(x.height - (h.height - parseFloat(getComputedStyle(document.querySelector('header')).borderBottomWidth))) < 0.01)
  }
})()`)
check(
  'the header carries all three caption buttons',
  !!cluster && cluster.count === 3,
  cluster && { count: cluster.count, ids: cluster.ids }
)
check(
  'every caption button opts out of the drag region',
  !!cluster && cluster.nodrag === true,
  cluster && { nodrag: cluster.nodrag }
)
check(
  'the caption cluster is contiguous and flush into the corner',
  !!cluster && cluster.gaps.every((g) => g === 0) && cluster.flushRight,
  cluster && { gaps: cluster.gaps, flushRight: cluster.flushRight }
)
check(
  'each caption button fills the header exactly',
  !!cluster && cluster.spansHeader === true,
  cluster && { spansHeader: cluster.spansHeader }
)

// --- 4. maximize round-trip ---
// Drives the whole path at once: renderer click -> IPC -> BrowserWindow.maximize() -> the OS's
// own `maximize` event -> the main->renderer broadcast -> the glyph's label. The label is the
// assertion precisely because it is fed by the broadcast, not by the click; if the renderer ever
// starts optimistically flipping its own state, this still passes but assertion 5 below catches
// it via the real window size.
const label = () =>
  main.evalJs(
    `document.querySelector('[data-testid="window-maximize"]').getAttribute('aria-label')`
  )
const widthNow = () => main.evalJs(`window.innerWidth`)
const restedLabel = await label()
const restedWidth = await widthNow()
await main.evalJs(`document.querySelector('[data-testid="window-maximize"]').click()`)
const wentMax = await waitFor(
  'the maximize label to flip to Restore',
  async () => ((await label()) === 'Restore' ? true : null),
  6000
).catch(() => false)
const maxWidth = await widthNow()
await main.evalJs(`document.querySelector('[data-testid="window-maximize"]').click()`)
const cameBack = await waitFor(
  'the maximize label to return to Maximize',
  async () => ((await label()) === 'Maximize' ? true : null),
  6000
).catch(() => false)
check(
  'maximize and restore round-trip through IPC and back',
  restedLabel === 'Maximize' && wentMax === true && cameBack === true,
  { restedLabel, wentMax, cameBack }
)
check(
  'maximizing actually resized the window, not just the label',
  typeof maxWidth === 'number' && typeof restedWidth === 'number' && maxWidth > restedWidth,
  { restedWidth, maxWidth }
)

// --- 5. the ambient layer reaches the window's top edge, under the header ---
// Only meaningful with the dynamic theme ON. When it is off there is no canvas at all and the
// header keeps its own ground, which assertion 7 covers instead.
const flow = await main.evalJs(`(() => {
  const cv = document.querySelector('canvas.dyn-ambient')
  const h = document.querySelector('header')
  const hs = getComputedStyle(h)
  if (!cv) {
    return { dynamic: false, headerBg: hs.backgroundColor, border: hs.borderBottomWidth }
  }
  const s = getComputedStyle(cv)
  const r = cv.getBoundingClientRect()
  const gl = cv.getContext('webgl2')
  return {
    dynamic: true,
    position: s.position, top: r.top, width: r.width, innerWidth: window.innerWidth,
    height: Math.round(r.height),
    canvasZ: parseInt(s.zIndex, 10), headerZ: parseInt(hs.zIndex, 10),
    headerBg: hs.backgroundColor, border: hs.borderBottomWidth,
    // A lost or absent context would fall back to the CSS gradient and still "look lit" in a
    // screenshot; assert the real thing is alive and sized.
    ctxAlive: !!gl && !gl.isContextLost(), buffer: [cv.width, cv.height]
  }
})()`)
if (flow && flow.dynamic) {
  check(
    'the ambient canvas is fixed to the window top edge, spanning its width',
    flow.position === 'fixed' && flow.top === 0 && Math.round(flow.width) === flow.innerWidth,
    flow
  )
  check('the ambient canvas extends past the header, so the flow covers it', flow.height > 48, {
    canvasHeight: flow.height,
    headerHeight: 48
  })
  check(
    'the header floats above the ambient layer and paints no ground of its own',
    flow.headerZ > flow.canvasZ &&
      (flow.headerBg === 'rgba(0, 0, 0, 0)' || flow.headerBg === 'transparent') &&
      parseFloat(flow.border) === 0,
    flow
  )
  check(
    'the WebGL context is alive and sized',
    flow.ctxAlive === true && flow.buffer[0] > 0 && flow.buffer[1] > 0,
    flow && { ctxAlive: flow.ctxAlive, buffer: flow.buffer }
  )
} else {
  // Dynamic theme off: the header must keep its own ground and hairline, or the bar reads as
  // unfinished on the classic theme.
  check(
    'with the dynamic theme off the header keeps its own ground and border',
    !!flow && flow.headerBg !== 'rgba(0, 0, 0, 0)' && parseFloat(flow.border) > 0,
    flow
  )
}

main.close()
report()
