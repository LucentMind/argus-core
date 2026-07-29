#!/usr/bin/env node
/**
 * Findings-pane layout runtime gate.
 *
 * jsdom (the renderer unit-test environment) loads no stylesheet, so no vitest assertion can
 * see whether the findings list actually reflows correctly, whether the severity token is
 * visible, or whether the action cluster is really invisible-but-focusable at rest. This script
 * drives the REAL Argus renderer over Chrome DevTools Protocol and measures those things with
 * `getComputedStyle`/`getBoundingClientRect` against the live DOM — this is the only place any
 * of those claims can be checked.
 *
 * ┌─────────────────────────────────────────────────────────────────────────────────────────┐
 * │ TAILWIND DOES NOT REGENERATE CSS FOR A NEWLY-INTRODUCED CLASS NAME UNDER HMR IN THIS      │
 * │ SETUP. If you add a class the running dev server has never seen before (e.g. change a    │
 * │ severity color, or restore a reveal class), Vite's HMR patches the JS bundle but the      │
 * │ Tailwind-generated stylesheet keeps its old content — the new class exists in the DOM but │
 * │ carries no rules, so it measures as if the change were never made. This produced four     │
 * │ false-negative debugging cycles. RESTART THE DEV SERVER after any class-name change,      │
 * │ before trusting a probe run against it.                                                   │
 * └─────────────────────────────────────────────────────────────────────────────────────────┘
 *
 * Usage (see the "Findings layout probe" section of the top-level README for the full walk):
 *   1. Boot the app once with a scratch ARGUS_HOME (creates + migrates argus.db), then quit.
 *   2. node scripts/findings-layout-fixture.mjs [SLUG]        (seeds the worst-case case)
 *   3. Launch the app again against the same ARGUS_HOME with a CDP debug port, e.g.:
 *        ARGUS_HOME=/path/to/home npx electron-vite dev --remoteDebuggingPort 9223
 *   4. node scripts/findings-layout-probe.mjs
 *
 * Env vars:
 *   CDP_PORT    default 9223
 *   CASE_TITLE  default "Findings layout probe" (must match the fixture's case title)
 *   WIDTHS      comma-separated pane widths to sweep, default "240,384,640"
 *   VIEWPORT_W  default 1800 — see the WIDTH gotcha below
 *
 * Exits 0 when every assertion passes, 1 otherwise (with the failing assertions listed).
 * Node 22 has a global `WebSocket` and `fetch`; no dependency is installed for this.
 */
const PORT = process.env.CDP_PORT || '9223'
const CASE_TITLE = process.env.CASE_TITLE || 'Findings layout probe'
const WIDTHS = (process.env.WIDTHS || '240,384,640').split(',').map((w) => Number(w.trim()))
const VIEWPORT_W = Number(process.env.VIEWPORT_W || 1800)

const targets = await (await fetch(`http://127.0.0.1:${PORT}/json/list`)).json()
const page = targets.find((t) => t.type === 'page' && !t.url.startsWith('devtools://'))
if (!page) {
  throw new Error(
    `no page target on CDP port ${PORT} — is the app running with --remoteDebuggingPort ${PORT}?`
  )
}

const ws = new WebSocket(page.webSocketDebuggerUrl)
let nextId = 0
const pending = new Map()
ws.addEventListener('message', (e) => {
  const m = JSON.parse(e.data)
  if (m.id && pending.has(m.id)) {
    pending.get(m.id)(m)
    pending.delete(m.id)
  }
})
await new Promise((res, rej) => {
  ws.addEventListener('open', res)
  ws.addEventListener('error', rej)
})

const send = (method, params) => {
  const id = ++nextId
  return new Promise((res) => {
    pending.set(id, res)
    ws.send(JSON.stringify({ id, method, params }))
  })
}

const evalJs = async (expression) => {
  const r = await send('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true })
  if (r.error) throw new Error(`CDP error: ${JSON.stringify(r.error)}`)
  if (r.result?.exceptionDetails) {
    throw new Error(
      `page threw: ${r.result.exceptionDetails.exception?.description ?? JSON.stringify(r.result.exceptionDetails)}`
    )
  }
  return r.result.result.value
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

/** Poll a boolean-returning page expression until true. A fixed sleep races the app's async
 *  loads (case list, findings fetch) — a 3.5s sleep caught the case list mid-load once. */
const waitFor = async (label, expr, timeoutMs = 20000) => {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    if (await evalJs(`!!(${expr})`)) return true
    await sleep(300)
  }
  throw new Error(`timed out waiting for ${label}`)
}

const assertions = []
const check = (name, pass, detail) => {
  assertions.push({ name, pass: !!pass, detail })
  const suffix = detail !== undefined ? ` — ${JSON.stringify(detail)}` : ''
  console.error(`${pass ? 'PASS' : 'FAIL'}  ${name}${suffix}`)
}

// The findings `aside` has no `shrink-0`, so in a narrow window it renders at its 240px
// min-width no matter what width is persisted — every requested width silently measured 240
// until this override was added. Widen first, before anything else.
await send('Emulation.setDeviceMetricsOverride', {
  width: VIEWPORT_W,
  height: 1000,
  deviceScaleFactor: 1,
  mobile: false
})

/** Blur whatever has focus and park the mouse in a corner, then settle. A stale focus or
 *  hover left over from a previous measurement invalidates the next "at rest" reading. */
const toRestState = async () => {
  await evalJs(`(() => { document.activeElement?.blur?.(); return 1 })()`)
  await send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: 2, y: 2, buttons: 0 })
  await sleep(400)
}

const openCase = async () => {
  await evalJs(`(() => {
    const card = [...document.querySelectorAll('div.cursor-pointer')]
      .find(d => d.textContent.includes(${JSON.stringify(CASE_TITLE)}))
    if (card) card.click()
    return !!card
  })()`)
}

const loadAtWidth = async (width) => {
  await evalJs(`localStorage.setItem('argus.ui.findingsWidth', '${width}');
    localStorage.setItem('argus.ui.findingsCollapsed', 'false'); 'ok'`)
  await send('Page.reload', {})
  // Idempotent retry: HMR (or a reload racing React's own render) can leave the app already on
  // the case page, or between renders, so poll-and-reclick rather than clicking exactly once.
  for (let i = 0; i < 25; i++) {
    if (
      await evalJs(`document.querySelectorAll('li [data-testid="finding-trailing"]').length >= 5`)
    )
      return
    await openCase()
    await sleep(700)
  }
  await waitFor(
    'finding cards',
    `document.querySelectorAll('li [data-testid="finding-trailing"]').length >= 5`
  )
}

const MEASURE_ROWS = `(() => {
  const cards = [...document.querySelectorAll('li')]
    .filter(li => li.querySelector('[data-testid="finding-trailing"]'))
  if (!cards.length) return { error: 'no finding cards rendered' }
  const rows = cards.map(c => c.querySelector('[data-testid="finding-trailing"]').parentElement)
  return {
    cardCount: cards.length,
    // A single-line meta row is 30px (24px h-6 trailing cell + pb-1.5), not <=26px — an
    // earlier, tighter threshold flagged every correctly-laid-out row as a failure.
    rowHeights: rows.map(r => Math.round(r.getBoundingClientRect().height)),
    rowsOneLine: rows.every(r => r.getBoundingClientRect().height <= 31),
    rowsNoOverflow: rows.every(r => r.scrollWidth <= r.clientWidth + 1),
    rowOverflowPx: rows.map(r => r.scrollWidth - r.clientWidth),
    // D2 regression guard: the severity token must never be the cell that yields width — it
    // measured 0px before this branch's fix, i.e. present in the DOM but invisible.
    severity: cards.map(c => {
      const sev = [...c.querySelectorAll('span')].find(s => /^(critical|major|minor)$/.test(s.textContent || ''))
      return { text: sev?.textContent ?? null, widthPx: sev ? Math.round(sev.getBoundingClientRect().width) : null }
    }),
    layerLabels: [...document.querySelectorAll('li .truncate')].map(el => ({
      text: (el.textContent || '').slice(0, 24),
      clipped: el.scrollWidth > el.clientWidth + 1
    })),
    badges: {
      codeMoved: document.querySelectorAll('li [title*="Recorded at"]').length,
      commented: [...document.querySelectorAll('li a')].filter(a => a.textContent === 'commented').length,
      pushedSha: document.querySelectorAll('li span[title^="Pushed"]').length
    }
  }
})()`

for (const width of WIDTHS) {
  await loadAtWidth(width)
  await toRestState()
  const paneWidth = await evalJs(
    `document.querySelector('aside[style*="width"]')?.getBoundingClientRect().width ?? null`
  )
  check(`pane actually renders at ${width}px, not clamped to min-width`, paneWidth === width, {
    requested: width,
    measured: paneWidth
  })

  const m = await evalJs(MEASURE_ROWS)
  if (m.error) {
    check(`meta rows exist at ${width}px`, false, m.error)
    continue
  }
  check(`no meta row overflows at ${width}px`, m.rowsNoOverflow, m.rowOverflowPx)
  check(
    `single-line meta rows measure ~30px at ${width}px (not clamped <=26px)`,
    m.rowsOneLine,
    m.rowHeights
  )
  const missingSeverity = m.severity.filter((s) => s.text && !(s.widthPx > 0))
  check(
    `severity token never collapses to 0px at ${width}px`,
    missingSeverity.length === 0,
    m.severity
  )
  if (width === WIDTHS[0]) {
    // The worst-case row (fixture finding #2) must carry every badge at once — proves the
    // narrowest width was actually exercised against the worst case, not a quiet one.
    check(
      'worst-case row carries all three status badges',
      m.badges.codeMoved >= 1 && m.badges.commented >= 1 && m.badges.pushedSha >= 1,
      m.badges
    )
  }
}

// ── Reveal-state checks: rest / hover / keyboard-focus / click-does-not-reveal. Behavior is
// independent of pane width, so these run once, at the narrowest (most cramped) width. ──
await loadAtWidth(WIDTHS[0])

const READ_CLUSTER = `(() => {
  const trailing = document.querySelector('li [data-testid="finding-trailing"]')
  const cluster = trailing.querySelector(':scope > div')
  const stamp = trailing.querySelector(':scope > span')
  return {
    clusterOpacity: getComputedStyle(cluster).opacity,
    clusterPointerEvents: getComputedStyle(cluster).pointerEvents,
    clusterDisplay: getComputedStyle(cluster).display,
    stampOpacity: getComputedStyle(stamp).opacity
  }
})()`

await toRestState()
const rest = await evalJs(READ_CLUSTER)
check(
  'cluster invisible and click-inert at rest',
  Number(rest.clusterOpacity) === 0 && rest.clusterPointerEvents === 'none',
  rest
)
check(
  'cluster is never display:none at rest (would break the tab order)',
  rest.clusterDisplay !== 'none',
  rest
)

// Hover: move the mouse onto the first card.
const cardBox = await evalJs(`(() => {
  const li = document.querySelector('li [data-testid="finding-trailing"]').closest('li')
  const r = li.getBoundingClientRect()
  return { x: Math.round(r.left + r.width / 2), y: Math.round(r.top + r.height / 2) }
})()`)
await send('Input.dispatchMouseEvent', {
  type: 'mouseMoved',
  x: cardBox.x,
  y: cardBox.y,
  buttons: 0
})
await sleep(400)
const hovered = await evalJs(READ_CLUSTER)
check('cluster reveals on mouse hover', Number(hovered.clusterOpacity) === 1, hovered)

// Mouse-out: park in the corner again and confirm it reverts.
await toRestState()
const afterMouseOut = await evalJs(READ_CLUSTER)
check(
  'cluster reverts to invisible after mouse-out',
  Number(afterMouseOut.clusterOpacity) === 0,
  afterMouseOut
)

// Keyboard focus: focus an action button directly (the real keyboard path — tab order, not a
// click). Must reveal even though no mouse ever entered the card.
await evalJs(`(() => {
  const btn = document.querySelector('li [data-testid="finding-trailing"] button')
  btn.focus()
  return 1
})()`)
await sleep(400)
const keyboardFocused = await evalJs(READ_CLUSTER)
check(
  'cluster reveals on keyboard focus of an action button',
  Number(keyboardFocused.clusterOpacity) === 1,
  keyboardFocused
)

// A mouse CLICK on the card's title toggle must NOT reveal the cluster — clicking to expand a
// card is not the same gesture as hovering or tabbing to the actions, and a stray revert here
// would mean the reveal is keying off the wrong ancestor.
await toRestState()
const titleBtn = await evalJs(`(() => {
  const b = [...document.querySelectorAll('li button[aria-expanded]')].find(x => !x.disabled)
  if (!b) return null
  const r = b.getBoundingClientRect()
  return { x: Math.round(r.left + r.width / 2), y: Math.round(r.top + r.height / 2) }
})()`)
if (titleBtn) {
  for (const type of ['mouseMoved', 'mousePressed', 'mouseReleased']) {
    await send('Input.dispatchMouseEvent', {
      type,
      x: titleBtn.x,
      y: titleBtn.y,
      button: 'left',
      clickCount: type === 'mouseMoved' ? 0 : 1,
      buttons: type === 'mousePressed' ? 1 : 0
    })
  }
  await sleep(300)
  await toRestState()
  const afterTitleClick = await evalJs(READ_CLUSTER)
  check(
    'a mouse click on the title toggle does not itself reveal the cluster',
    Number(afterTitleClick.clusterOpacity) === 0,
    afterTitleClick
  )
} else {
  check(
    'a mouse click on the title toggle does not itself reveal the cluster',
    false,
    'no expandable finding found to click'
  )
}

// ── Selection footer: tick a batch-apply checkbox so the footer actually renders and gets
// measured. The footer defect on this branch slipped through precisely because an earlier
// fixture never selected anything, so the footer never existed to measure. ──
await toRestState()
await evalJs(`(() => {
  const cb = document.querySelector('input[aria-label^="Select finding"]')
  if (cb) cb.click()
  return !!cb
})()`)
await sleep(400)
const footer = await evalJs(`(() => {
  const btn = [...document.querySelectorAll('button')].find(b => /^Apply selected/.test(b.textContent || ''))
  if (!btn) return { error: 'no selection footer rendered' }
  const row = btn.parentElement
  return {
    rowHeight: Math.round(row.getBoundingClientRect().height),
    overflowPx: row.scrollWidth - row.clientWidth
  }
})()`)
if (footer.error) {
  check('selection footer renders once a finding is selected', false, footer.error)
} else {
  check('selection footer does not overflow its row', footer.overflowPx <= 1, footer)
}

ws.close()

const failed = assertions.filter((a) => !a.pass)
console.log(
  JSON.stringify({ total: assertions.length, failed: failed.length, assertions }, null, 2)
)
if (failed.length > 0) {
  console.error(`\n${failed.length}/${assertions.length} assertions FAILED`)
  process.exit(1)
}
console.error(`\nall ${assertions.length} assertions passed`)
