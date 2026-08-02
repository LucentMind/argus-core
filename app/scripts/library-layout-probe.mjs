#!/usr/bin/env node
/**
 * Library-row layout runtime gate.
 *
 * jsdom (the renderer unit-test environment) loads no stylesheet, so no vitest assertion can see
 * that a badge-heavy `SettingRow` squeezes its label to min-content and breaks the skill name
 * mid-word. This drives the REAL renderer over Chrome DevTools Protocol and measures the label
 * cell with `getBoundingClientRect` against the live DOM.
 *
 * ┌─────────────────────────────────────────────────────────────────────────────────────────┐
 * │ TAILWIND DOES NOT REGENERATE CSS FOR A NEWLY-INTRODUCED CLASS NAME UNDER HMR IN THIS      │
 * │ SETUP. Restart the dev server after any class-name change before trusting a probe run.    │
 * └─────────────────────────────────────────────────────────────────────────────────────────┘
 *
 * Usage:
 *   1. ARGUS_HOME=/path/to/home node scripts/library-layout-fixture.mjs
 *   2. ARGUS_HOME=/path/to/home npx electron-vite dev --remoteDebuggingPort=9237
 *   3. node scripts/library-layout-probe.mjs
 *
 * Env vars:
 *   CDP_PORT    default 9237
 *   SKILL_NAME  default "triage-a-flaky-test" (must match the fixture)
 *   WIDTHS      comma-separated window widths to sweep, default "1600,1440,1280". 1280 is not
 *               an arbitrary floor — it is the app's own `minWidth` (src/main/index.ts), so the
 *               sweep already ends at the narrowest window a user can actually produce.
 *
 * Exits 0 when every assertion passes, 1 otherwise.
 * Node 22 has a global `WebSocket` and `fetch`; no dependency is installed for this.
 */
const PORT = process.env.CDP_PORT || '9237'
const SKILL_NAME = process.env.SKILL_NAME || 'triage-a-flaky-test'
const WIDTHS = (process.env.WIDTHS || '1600,1440,1280').split(',').map((w) => Number(w.trim()))

const targets = await (await fetch(`http://127.0.0.1:${PORT}/json/list`)).json()
const page = targets.find((t) => t.type === 'page' && !t.url.startsWith('devtools://'))
if (!page) {
  throw new Error(
    `no page target on CDP port ${PORT} — is the app running with --remoteDebuggingPort=${PORT}?`
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

const assertions = []
const check = (name, pass, detail) => {
  assertions.push({ name, pass: !!pass, detail })
  const suffix = detail !== undefined ? ` — ${JSON.stringify(detail)}` : ''
  console.error(`${pass ? 'PASS' : 'FAIL'}  ${name}${suffix}`)
}

/**
 * Refuse to drive an instance that is not the fixture's.
 *
 * A sibling worktree's dev instance had already taken the default port, so `/json/list` handed
 * back ITS page and the probe clicked around a real, populated app for thirty iterations before
 * timing out. Ask over IPC — no clicking — whether this renderer's home holds the fixture skill,
 * and bail before touching anything if it does not.
 */
const assertFixtureInstance = async () => {
  const found = await evalJs(`window.argus.skills.list().then(p =>
    p.skills.some(s => s.name === ${JSON.stringify(SKILL_NAME)} && s.tier === 'user'))`)
  if (!found) {
    throw new Error(
      `CDP port ${PORT} is serving an Argus whose home has no user-tier "${SKILL_NAME}" — ` +
        `wrong instance (another worktree may hold this port). Run the fixture against this ` +
        `app's ARGUS_HOME, or boot yours on a port nothing else is using.`
    )
  }
}

const clickByLabel = (label) =>
  evalJs(`(() => {
  const b = [...document.querySelectorAll('button')]
    .find(x => x.getAttribute('aria-label') === ${JSON.stringify(label)} ||
               x.textContent.trim() === ${JSON.stringify(label)})
  if (b) b.click()
  return !!b
})()`)

/** Poll-and-reclick rather than clicking once: a reload racing React's mount leaves the app on
 *  the home view, and a single blind click is lost. */
const openLibrary = async () => {
  for (let i = 0; i < 30; i++) {
    if (await evalJs(`!!document.querySelector('[aria-label="open · ${SKILL_NAME}"]')`)) return
    await clickByLabel('Settings')
    await sleep(250)
    await clickByLabel('Library')
    await sleep(450)
  }
  throw new Error(`timed out waiting for the "${SKILL_NAME}" library row`)
}

/** Measure the row: the label button (the name), the line-1 flex span holding name + chips,
 *  and the label column that span sits in. */
const MEASURE = `(() => {
  const btn = document.querySelector('[aria-label="open · ${SKILL_NAME}"]')
  if (!btn) return { error: 'skill row not rendered' }
  const line = btn.parentElement                    // span: name + chips
  const column = line.parentElement                 // div: label column (label line + description)
  const row = column.parentElement                  // div.group/row
  const controls = row.lastElementChild
  const box = (el) => {
    const r = el.getBoundingClientRect()
    return { w: Math.round(r.width), h: Math.round(r.height) }
  }
  const lineHeight = parseFloat(getComputedStyle(btn).lineHeight) || 20
  const chips = [...line.children].filter(c => c !== btn).map(c => ({
    text: (c.textContent || '').trim().slice(0, 28),
    w: Math.round(c.getBoundingClientRect().width)
  }))
  return {
    name: { ...box(btn), lines: Math.round(box(btn).h / lineHeight) },
    labelLine: box(line),
    labelColumn: box(column),
    row: box(row),
    controls: box(controls),
    chipCount: chips.length,
    chips,
    // Does the name render on one line, i.e. is it never broken mid-word?
    nameIntact: btn.getBoundingClientRect().height <= lineHeight * 1.5,
    // Nothing may be clipped or spill out of the row.
    rowOverflowPx: row.scrollWidth - row.clientWidth,
    lineOverflowPx: line.scrollWidth - line.clientWidth,
    columnOverflowPx: column.scrollWidth - column.clientWidth
  }
})()`

const atWidth = async (width) => {
  await send('Emulation.setDeviceMetricsOverride', {
    width,
    height: 1000,
    deviceScaleFactor: 1,
    mobile: false
  })
  await sleep(500)
  await openLibrary()
  await sleep(300)
  return evalJs(MEASURE)
}

await assertFixtureInstance()

for (const width of WIDTHS) {
  const m = await atWidth(width)
  if (m.error) {
    check(`library row renders at ${width}px`, false, m.error)
    continue
  }
  check(`worst-case row carries its full badge load at ${width}px`, m.chipCount >= 4, {
    chipCount: m.chipCount,
    chips: m.chips
  })
  check(`skill name is not broken mid-word at ${width}px`, m.nameIntact, {
    name: m.name,
    labelColumn: m.labelColumn,
    controls: m.controls
  })
  check(`nothing overflows the row at ${width}px`, m.rowOverflowPx <= 1 && m.lineOverflowPx <= 1, {
    row: m.rowOverflowPx,
    labelLine: m.lineOverflowPx,
    column: m.columnOverflowPx
  })
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
