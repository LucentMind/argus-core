#!/usr/bin/env node
/**
 * Dynamic-theme CDP acceptance for the case view and Settings (task 9, spec
 * 2026-07-31-dynamic-theme-case-settings-design.md). Tasks 4-8 built the case/settings bands,
 * the glass materials, and the accent rails behind unit tests alone — jsdom loads no
 * stylesheet, enforces no CSP, and composites nothing, so none of that was ever actually
 * looked at. This drives the real app over CDP and checks the seven things the task-9 brief
 * asks for, printing one pass/fail line per check via `lib/cdp.mjs`'s `check()`/`report()`.
 *
 * Follows `cdp-editor-window.mjs`'s launch pattern exactly: an isolated ARGUS_HOME, a fixed
 * debug port, node 22's global `WebSocket`/`fetch` — no dependencies beyond node's own
 * built-in `zlib` (used to decode the 1x1 screenshot PNGs the pixel-seam checks read).
 *
 * Usage:
 *   1. Seed a scratch home (creates <home>, no argus.db yet):
 *        mkdir -p /tmp/argus-dyn-views && ARGUS_HOME=/tmp/argus-dyn-views npm run dev
 *      quit the app once it boots (migrations run on first boot), then:
 *        ARGUS_HOME=/tmp/argus-dyn-views node scripts/seed/dynamicThemeViews.mjs
 *   2. Boot the app against the same home with a debug port:
 *        ARGUS_HOME=/tmp/argus-dyn-views npx electron-vite dev --remoteDebuggingPort 9223
 *   3. node scripts/cdp-dynamic-theme-views.mjs
 *
 * Env: CDP_PORT (default 9223).
 * Exits 0 when every check passes, 1 otherwise.
 *
 * Pixel sampling: CDP `Page.captureScreenshot` with a 1x1 `clip` at the target CSS-pixel
 * coordinate, decoded by hand (signature + IHDR + concatenated IDAT inflated via node's
 * built-in `zlib`, then the single scanline's filter byte skipped — for a 1x1 image every PNG
 * filter type reduces to "pass the raw byte through", since the predictor's neighbours are all
 * defined as 0 for the first pixel of the first row). This reads the REAL composited frame
 * (WebGL canvas + any glass/backdrop-filter layers above it), not an in-page canvas readback —
 * which matters because `AmbientCanvas` creates its WebGL2 context without
 * `preserveDrawingBuffer`, and because the seam this task cares about is what a person would
 * actually see, not just what the shader wrote to its own buffer.
 *
 * StrictMode trap (see AmbientCanvas.tsx / task-8 report): a shader that fails to compile with
 * a null COMPILE_STATUS and an EMPTY info log is not a GLSL error, it is a lost context from a
 * reused canvas. If that appears here, it is a regression in the fresh-canvas-per-effect-run
 * fix, not something to work around in this driver.
 */
import zlib from 'node:zlib'
import {
  listTargets as list,
  connect,
  mainWindow,
  sleep,
  waitFor,
  check,
  report
} from './lib/cdp.mjs'

const PORT = process.env.CDP_PORT || '9223'
const listTargets = () => list(PORT)
const SLUG = 'DTV-1-p1'

// ── CDP plumbing not already in lib/cdp.mjs ────────────────────────────────────────────────

async function sendOk(conn, method, params) {
  const r = await conn.send(method, params)
  if (r.error) throw new Error(`${method} failed: ${JSON.stringify(r.error)}`)
  return r.result
}

/** Force the page's CSS viewport to an exact size, independent of the actual OS window —
 *  the same mechanism regular Chrome DevTools device emulation uses. deviceScaleFactor: 1
 *  keeps CSS-pixel clip coordinates below identical to device pixels, which the 1x1
 *  screenshot decode below assumes. */
async function setViewport(conn, width, height) {
  await sendOk(conn, 'Emulation.setDeviceMetricsOverride', {
    width,
    height,
    deviceScaleFactor: 1,
    mobile: false
  })
}
async function clearViewport(conn) {
  await sendOk(conn, 'Emulation.clearDeviceMetricsOverride', {})
}
/** Always emulates an EXPLICIT value, never an empty feature list. Sending `features: []`
 *  clears the override and falls back to the host's real OS setting — so on a machine that
 *  has "reduce motion" enabled system-wide, the `false` case silently measures the reduced
 *  rate and the check fails for a reason that has nothing to do with the app. The whole
 *  point of emulation here is to make the measurement independent of the host. */
async function setReducedMotion(conn, on) {
  await sendOk(conn, 'Emulation.setEmulatedMedia', {
    features: [{ name: 'prefers-reduced-motion', value: on ? 'reduce' : 'no-preference' }]
  })
}

/** Decode a PNG buffer that is known to be exactly 1x1, 8-bit RGB or RGBA, returning [r,g,b]
 *  0-255. See the module doc comment for why a 1x1 image needs no real unfiltering. */
function decode1x1Png(buf) {
  if (buf.readUInt32BE(0) !== 0x89504e47) throw new Error('not a PNG')
  let offset = 8
  let width = 0
  let height = 0
  let colorType = -1
  const idatChunks = []
  while (offset < buf.length) {
    const len = buf.readUInt32BE(offset)
    const type = buf.toString('ascii', offset + 4, offset + 8)
    const data = buf.subarray(offset + 8, offset + 8 + len)
    if (type === 'IHDR') {
      width = data.readUInt32BE(0)
      height = data.readUInt32BE(4)
      colorType = data[9]
    } else if (type === 'IDAT') {
      idatChunks.push(data)
    } else if (type === 'IEND') {
      break
    }
    offset += 8 + len + 4 // length + type + data + crc
  }
  if (width !== 1 || height !== 1) {
    throw new Error(`expected a 1x1 screenshot, got ${width}x${height}`)
  }
  const raw = zlib.inflateSync(Buffer.concat(idatChunks))
  // raw[0] is the (irrelevant, for a single first pixel) filter type byte; pixel bytes follow.
  if (colorType !== 2 && colorType !== 6) throw new Error(`unsupported PNG colorType ${colorType}`)
  return [raw[1], raw[2], raw[3]]
}

/** The composited colour at one CSS-pixel viewport coordinate. */
async function screenshotPixel(conn, x, y) {
  const r = await sendOk(conn, 'Page.captureScreenshot', {
    format: 'png',
    clip: { x, y, width: 1, height: 1, scale: 1 },
    fromSurface: true
  })
  return decode1x1Png(Buffer.from(r.data, 'base64'))
}

function hexToRgb255(hex) {
  const s = (hex || '').trim()
  const six = /^#?([0-9a-f]{6})$/i.exec(s)
  if (six) {
    const n = parseInt(six[1], 16)
    return [(n >> 16) & 255, (n >> 8) & 255, n & 255]
  }
  const three = /^#?([0-9a-f]{3})$/i.exec(s)
  if (three) {
    const n = parseInt(three[1], 16)
    return [((n >> 8) & 15) * 17, ((n >> 4) & 15) * 17, (n & 15) * 17]
  }
  throw new Error(`not a hex colour: ${hex}`)
}

const dist = (a, b) => Math.max(Math.abs(a[0] - b[0]), Math.abs(a[1] - b[1]), Math.abs(a[2] - b[2]))

// ── page-level helpers, all via evalJs (element.click() dispatches a real, bubbling
// MouseEvent — same as every existing cdp-*.mjs gate does; no Input-domain synthesis needed
// for a plain click) ────────────────────────────────────────────────────────────────────────

const clickSelector = (conn, sel) =>
  conn.evalJs(`(() => {
    const el = document.querySelector(${JSON.stringify(sel)})
    if (!el) return false
    el.click()
    return true
  })()`)

/** Click the settings-nav button (or TopBar-style button) whose visible label text matches. */
const clickByLabel = (conn, containerSel, label) =>
  conn.evalJs(`(() => {
    const root = document.querySelector(${JSON.stringify(containerSel)})
    if (!root) return false
    const btn = [...root.querySelectorAll('button')].find(
      b => (b.textContent || '').trim().startsWith(${JSON.stringify(label)})
    )
    if (!btn) return false
    btn.click()
    return true
  })()`)

const gotoHome = async (conn) => {
  await clickSelector(conn, 'button[aria-label="All cases"]')
  await waitFor('home view', () =>
    conn.evalJs(
      `!!document.querySelector('[data-testid="dynamic-home"], .flex.min-h-0.flex-1.flex-col.overflow-y-auto')`
    )
  )
}

/** Idempotent: the gear is a TOGGLE (App.tsx's openSettings — a second click while already on
 *  Settings closes it back to whatever view was open before), so this must not click blindly on
 *  every call. `dynamic-settings`'s wrapper div renders unconditionally whenever the Settings
 *  view is showing (DynamicScope always renders the case/settings wrapper, dynamic theme on or
 *  off — only home collapses to a fragment when off), so it is a safe already-there check
 *  regardless of the dynamic-theme state. */
const openSettings = async (conn) => {
  if (await conn.evalJs(`!!document.querySelector('[data-testid="dynamic-settings"]')`)) return
  await clickSelector(conn, 'button[aria-label="Settings"]')
  await waitFor('settings view', () =>
    conn.evalJs(`!!document.querySelector('[data-testid="dynamic-settings"]')`)
  )
}

const openCase = async (conn, slug) => {
  await conn.evalJs(`(() => {
    const el = [...document.querySelectorAll('.text-defect')].find(e => e.textContent.trim() === ${JSON.stringify(slug)})
    const card = el && el.closest('.group')
    if (!card) return false
    card.click()
    return true
  })()`)
  await waitFor(`case view (${slug})`, () =>
    conn.evalJs(`!!document.querySelector('[data-testid="dynamic-case"]')`)
  )
}

/** The Settings > General > "Dynamic theme" switch. Reads its own aria-checked rather than
 *  trusting the caller's idea of the current state, and no-ops if already there. */
async function setDynamicTheme(conn, on) {
  await openSettings(conn)
  await clickByLabel(conn, 'nav[aria-label="Settings sections"]', 'General')
  await waitFor('General settings page', () =>
    conn.evalJs(`!!document.querySelector('button[aria-label="Dynamic theme"]')`)
  )
  const current = await conn.evalJs(
    `document.querySelector('button[aria-label="Dynamic theme"]').getAttribute('aria-checked') === 'true'`
  )
  if (current !== on) {
    await clickSelector(conn, 'button[aria-label="Dynamic theme"]')
    await sleep(250)
  }
}

/** The TopBar's quick theme toggle — real UI control, not a store poke. */
async function setTheme(conn, theme) {
  const current = await conn.evalJs(`document.documentElement.getAttribute('data-theme')`)
  if (current === theme) return
  await clickSelector(conn, 'button[aria-label^="Switch to"]')
  await waitFor(`theme => ${theme}`, () =>
    conn.evalJs(`document.documentElement.getAttribute('data-theme') === ${JSON.stringify(theme)}`)
  )
}

const rect = (conn, sel) =>
  conn.evalJs(`(() => {
    const el = document.querySelector(${JSON.stringify(sel)})
    if (!el) return null
    const r = el.getBoundingClientRect()
    return { top: r.top, left: r.left, right: r.right, bottom: r.bottom, width: r.width, height: r.height }
  })()`)

const computedVoid = (conn, scopeSel) =>
  conn.evalJs(
    `getComputedStyle(document.querySelector(${JSON.stringify(scopeSel)})).getPropertyValue('--void').trim()`
  )

// ── main ─────────────────────────────────────────────────────────────────────────────────

async function main() {
  const targets = await listTargets()
  if (targets.length === 0) {
    throw new Error(`no page target on CDP port ${PORT} — is the app running with a debug port?`)
  }
  const conn = await connect(mainWindow(targets) ?? targets[0])
  await setViewport(conn, 1280, 900)
  await gotoHome(conn)

  // Every check below assumes the dynamic theme is on; check 4 flips it off/on itself and
  // restores it, check 6 measures both states explicitly.
  await setDynamicTheme(conn, true)

  // ── 1. Case view band: dark/light x 1280/1920, no seam at the band's bottom edge or the
  // scope's own bottom edge. ──
  {
    const fails = []
    for (const theme of ['dark', 'light']) {
      for (const width of [1280, 1920]) {
        await setViewport(conn, width, 900)
        await setTheme(conn, theme)
        await gotoHome(conn)
        await openCase(conn, SLUG)
        await sleep(600) // let the ambient effect run its first refresh() + a few rAF frames

        const hasCanvas = await conn.evalJs(
          `!!document.querySelector('[data-testid="dynamic-case"] canvas.dyn-ambient')`
        )
        const hasFallback = await conn.evalJs(
          `!!document.querySelector('[data-testid="dynamic-case"] .dyn-ambient-fallback')`
        )
        const label = `${theme}/${width}`
        if (!hasCanvas || hasFallback) {
          fails.push({
            combo: label,
            reason: 'fallback rendered instead of the WebGL band',
            hasCanvas,
            hasFallback
          })
          continue
        }

        const canvasRect = await rect(conn, '[data-testid="dynamic-case"] canvas.dyn-ambient')
        const wrapperRect = await rect(conn, '[data-testid="dynamic-case"]')
        const voidHex = await computedVoid(conn, '[data-testid="dynamic-case"]')
        const voidRgb = hexToRgb255(voidHex)

        const x = Math.round(canvasRect.left + canvasRect.width / 2)
        const bandBottomPixel = await screenshotPixel(conn, x, Math.round(canvasRect.bottom + 1))
        const bandBottomDist = dist(bandBottomPixel, voidRgb)

        // "the scope's bottom edge": deep inside the left rail, well past the band, near the
        // very bottom of the view — must read as the same ground, no leftover glow/seam.
        const railX = Math.round(wrapperRect.left + 12)
        const deepY = Math.round(wrapperRect.bottom - 8)
        const scopeBottomPixel = await screenshotPixel(conn, railX, deepY)
        const scopeBottomDist = dist(scopeBottomPixel, voidRgb)

        const TOL = 8
        if (bandBottomDist > TOL || scopeBottomDist > TOL) {
          fails.push({
            combo: label,
            reason: 'seam: sampled colour does not match computed --void',
            voidHex,
            voidRgb,
            bandBottomPixel,
            bandBottomDist,
            scopeBottomPixel,
            scopeBottomDist,
            tolerance: TOL
          })
        }
      }
    }
    check(
      '1. case band renders (dark/light x 1280/1920), no seam at band or scope bottom',
      fails.length === 0,
      fails.length ? fails : undefined
    )
  }
  await clearViewport(conn)
  await setViewport(conn, 1280, 900)

  // ── 2. P1 case + a PR with one failing check: both accents present in computed styles. ──
  {
    await setTheme(conn, 'dark')
    await gotoHome(conn)
    await openCase(conn, SLUG)
    const headerTier = await waitFor(
      'case header data-tier=p1',
      () =>
        conn
          .evalJs(
            `document.querySelector('[data-testid="dynamic-case"] header')?.getAttribute('data-tier') || null`
          )
          .then((v) => (v === 'p1' ? v : null)),
      15000
    ).catch(() => null)
    // The PR rail's data-tier only flips to p1 once its rollup resolves to 'failing' — the
    // placeholder the fixture seeds already reads that way, but this also waits out the real
    // `gh` refresh review mode triggers on mount, so this checks live data, not just the seed.
    const prTier = await waitFor(
      'PR rail data-tier=p1',
      () =>
        conn
          .evalJs(
            `document.querySelector('.glass-panel[data-tier]')?.getAttribute('data-tier') || null`
          )
          .then((v) => (v === 'p1' ? v : null)),
      20000
    ).catch(() => null)
    check(
      '2. P1 case header + failing-PR rail both carry data-tier=p1',
      headerTier === 'p1' && prTier === 'p1',
      { headerTier, prTier }
    )
  }

  // ── 3. Settings masthead + nav-rail lighting, dark/light x three pages. ──
  {
    const PAGES = [
      {
        id: 'general',
        label: 'General',
        blurb: 'Appearance, case defaults, and how the workspace shell behaves.'
      },
      {
        id: 'agent',
        label: 'Agent',
        blurb: 'Providers, models, and what the analyst may do without asking.'
      },
      {
        id: 'library',
        label: 'Library',
        blurb: 'Skills and references available to the analyst, and which this workspace owns.'
      }
    ]
    const fails = []
    for (const theme of ['dark', 'light']) {
      await setTheme(conn, theme)
      await openSettings(conn)
      for (const p of PAGES) {
        await clickByLabel(conn, 'nav[aria-label="Settings sections"]', p.label)
        await waitFor(`${p.label} settings page`, () =>
          conn.evalJs(
            `document.querySelector('[data-testid="settings-title"]')?.textContent === ${JSON.stringify(p.label)}`
          )
        )
        const title = await conn.evalJs(
          `document.querySelector('[data-testid="settings-title"]')?.textContent`
        )
        const blurb = await conn.evalJs(
          `document.querySelector('[data-testid="settings-blurb"]')?.textContent`
        )
        const mastheadOk = title === p.label && blurb === p.blurb

        const navRect = await rect(conn, 'nav[aria-label="Settings sections"]')
        const voidRgb = hexToRgb255(await computedVoid(conn, '[data-testid="dynamic-settings"]'))
        const topPixel = await screenshotPixel(
          conn,
          Math.round(navRect.left + 10),
          Math.round(navRect.top + 4)
        )
        const bottomPixel = await screenshotPixel(
          conn,
          Math.round(navRect.left + 10),
          Math.round(navRect.bottom - 6)
        )
        // "Lit" = the top of the rail visibly differs from the plain --void ground (the ribbon's
        // tint bleeding through the transparent .dyn-rail), while deep in the rail it has already
        // faded back to --void — same no-seam invariant check 1 verifies, from the other end.
        // A brightness-only comparison is theme-direction-dependent (dark: a glow on black reads
        // BRIGHTER; light: the shader mixes the void toward pastels that are themselves LESS
        // luminant than the pale --void ground, so the same light reads very slightly DARKER) —
        // colour distance from --void is the one signal that means "lit" in both directions.
        const topDist = dist(topPixel, voidRgb)
        const bottomDist = dist(bottomPixel, voidRgb)
        const lit = topDist >= 2 && topDist > bottomDist

        if (!mastheadOk || !lit) {
          fails.push({
            theme,
            page: p.label,
            title,
            expectedTitle: p.label,
            blurbOk: blurb === p.blurb,
            voidRgb,
            topPixel,
            bottomPixel,
            topDist,
            bottomDist,
            lit
          })
        }
      }
    }
    check(
      '3. Settings masthead + lit nav-rail top (dark/light x 3 pages)',
      fails.length === 0,
      fails.length ? fails : undefined
    )
  }

  // ── 4. Toggling the switch restyles the page and preserves scroll position. ──
  {
    await setTheme(conn, 'dark')
    await openSettings(conn)
    await clickByLabel(conn, 'nav[aria-label="Settings sections"]', 'General')
    await setViewport(conn, 1280, 560) // force the content column to overflow
    await sleep(200)
    const SCROLL_SEL = 'div.min-w-0.flex-1.overflow-y-auto'
    await conn.evalJs(`document.querySelector(${JSON.stringify(SCROLL_SEL)}).scrollTop = 140`)
    await sleep(150)
    const before = await conn.evalJs(
      `document.querySelector(${JSON.stringify(SCROLL_SEL)}).scrollTop`
    )
    const wasOn = await conn.evalJs(
      `!!document.querySelector('[data-testid="dynamic-settings"].dyn')`
    )

    await clickSelector(conn, 'button[aria-label="Dynamic theme"]')
    await sleep(300)

    const after = await conn.evalJs(
      `document.querySelector(${JSON.stringify(SCROLL_SEL)}).scrollTop`
    )
    const isOnNow = await conn.evalJs(
      `!!document.querySelector('[data-testid="dynamic-settings"].dyn')`
    )
    const restyled = isOnNow !== wasOn
    const scrollPreserved = before > 0 && Math.abs(after - before) <= 2

    // restore: leave dynamic theme ON for the rest of the run, and undo the forced height.
    if (!isOnNow) {
      await clickSelector(conn, 'button[aria-label="Dynamic theme"]')
      await sleep(200)
    }
    await clearViewport(conn)
    await setViewport(conn, 1280, 900)

    check(
      '4. Toggling Dynamic theme in Settings restyles the page, preserves scroll',
      restyled && scrollPreserved,
      {
        before,
        after,
        wasOn,
        isOnNow,
        restyled,
        scrollPreserved
      }
    )
  }

  // ── 5. 10x home -> case -> settings -> home: exactly one live canvas.dyn-ambient after.
  //
  // A plain `webglcontextlost` listener on `window` (capture phase) cannot observe the
  // cleanup's deliberate `loseContext()` call: AmbientCanvas calls it and THEN `canvas.remove()`
  // in the same synchronous cleanup, and the extension's context-loss event is dispatched
  // asynchronously — by the time it actually fires, the canvas is already detached, and a
  // detached node has no ancestors for a capture-phase window listener to see it through
  // (verified empirically). So this patches `WebGL2RenderingContext.prototype.getExtension`
  // once at boot to count real `WEBGL_lose_context.loseContext()` calls directly, which is
  // agnostic to DOM attachment and gives an exact count of real disposals regardless.
  //
  // Also verified empirically: DynamicScope/AmbientCanvas turn out to be LONG-LIVED across a
  // plain view switch. React reconciles the same component type at the same JSX position
  // rather than unmounting it when `view.kind` changes between home/case/settings (all three
  // branches render the same `<DynamicScope>`/`<AmbientCanvas>` at that slot) — confirmed by
  // tagging the live canvas element with a marker attribute and watching it survive ten
  // home<->case round trips unchanged, and by this exact counter staying at 0 across pure
  // navigation. That is a deliberate, reasonable design (case/settings "ALWAYS render the
  // wrapper" per DynamicScope's own doc comment, specifically so a view switch doesn't discard
  // state) — NOT a bug, and not this check's concern. So the correct expectation from ten pure
  // navigations is: no leaked/duplicate canvas (`canvasCount === 1`, the primary invariant) AND
  // no hidden churn of contexts being silently created and destroyed behind that single visible
  // canvas either (`disposed` stays at whatever small, bounded value dev-mode StrictMode's
  // one-time double-invoke produced before the loop started, not growing with each navigation). ──
  {
    const before = await conn.evalJs(`(() => {
      if (!window.__disposed) {
        window.__disposed = 0
        const orig = WebGL2RenderingContext.prototype.getExtension
        WebGL2RenderingContext.prototype.getExtension = function (name) {
          const ext = orig.call(this, name)
          if (name === 'WEBGL_lose_context' && ext) {
            const origLose = ext.loseContext.bind(ext)
            ext.loseContext = function () {
              window.__disposed++
              return origLose()
            }
          }
          return ext
        }
      }
      return window.__disposed
    })()`)
    await gotoHome(conn)
    for (let i = 0; i < 10; i++) {
      await openCase(conn, SLUG)
      await sleep(150)
      await openSettings(conn)
      await sleep(150)
      await gotoHome(conn)
      await sleep(150)
    }
    const canvasCount = await conn.evalJs(`document.querySelectorAll('canvas.dyn-ambient').length`)
    const after = await conn.evalJs(`window.__disposed`)
    const disposedDuringNav = after - before
    check(
      '5. 10x home->case->settings->home leaves exactly one live canvas, no hidden context churn',
      canvasCount === 1 && disposedDuringNav === 0,
      { canvasCount, disposedDuringNav }
    )
  }

  // ── 6. rAF frame-time over 5s while scrolling the evidence list, dynamic on vs off. ──
  {
    async function measure() {
      await gotoHome(conn)
      await openCase(conn, SLUG)
      await waitFor('evidence list scrollable', () =>
        conn.evalJs(
          `(() => { const ul = document.querySelector('ul.overflow-y-auto'); return !!ul && ul.scrollHeight > ul.clientHeight + 40 })()`
        )
      )
      await conn.evalJs(`(() => {
        window.__frames = []
        window.__frameDone = false
        const ul = document.querySelector('ul.overflow-y-auto')
        let last = performance.now()
        const start = last
        let dir = 1
        function frame(t) {
          window.__frames.push(t - last)
          last = t
          ul.scrollTop += 8 * dir
          if (ul.scrollTop <= 0 || ul.scrollTop >= ul.scrollHeight - ul.clientHeight) dir *= -1
          if (t - start < 5000) requestAnimationFrame(frame)
          else window.__frameDone = true
        }
        requestAnimationFrame(frame)
        return true
      })()`)
      await waitFor(
        '5s scroll/frame measurement to finish',
        () => conn.evalJs(`window.__frameDone === true`),
        8000
      )
      const frames = await conn.evalJs(`window.__frames`)
      const warm = frames.slice(3) // drop the first few frames (layout/measure warmup)
      const avg = warm.reduce((a, b) => a + b, 0) / warm.length
      const max = Math.max(...warm)
      return { avg, max, n: warm.length }
    }

    await setDynamicTheme(conn, true)
    const on = await measure()
    await setDynamicTheme(conn, false)
    const off = await measure()
    await setDynamicTheme(conn, true) // restore for anything after

    const FRAME_BUDGET_MS = 1000 / 60
    const regression = on.avg - off.avg
    const pass = regression <= FRAME_BUDGET_MS
    check(
      '6. Evidence-list scroll frame-time: dynamic-on vs dynamic-off within one frame budget',
      pass,
      {
        dynamicOn: on,
        dynamicOff: off,
        regressionMs: regression,
        frameBudgetMs: FRAME_BUDGET_MS
      }
    )
  }

  // ── 7. prefers-reduced-motion: reduce, both themes — the ambient shader's own time-rate
  // uniform actually slows down. Sampled via gl.getUniform on the LIVE context, in place,
  // without navigating away and back: DynamicScope/AmbientCanvas turn out to be long-lived —
  // React reconciles the same component type at the same tree position across a home/case/
  // settings switch rather than unmounting it (confirmed empirically: a canvas tagged with a
  // marker attribute keeps the same identity across ten home<->case round trips, and a
  // `WEBGL_lose_context.loseContext` call-counter patched onto the prototype stays at 0 across
  // navigation, only incrementing when Dynamic Theme itself is toggled off then on). AmbientCanvas
  // was fixed (this task) to re-read `matchMedia('(prefers-reduced-motion: reduce)').matches`
  // every frame rather than snapshotting it once at mount, specifically so this holds regardless
  // of when the effect last (re)ran — and independent of whether the browser fires the
  // MediaQueryList `change` event at all, which CDP's `Emulation.setEmulatedMedia` does not
  // (verified empirically: a `change` listener never fires under it, though `.matches` itself
  // does flip immediately). ──
  {
    async function sample() {
      return conn.evalJs(`(() => {
        const canvas = document.querySelector('[data-testid="dynamic-case"] canvas.dyn-ambient')
        if (!canvas) return null
        const gl = canvas.getContext('webgl2')
        const prog = gl.getParameter(gl.CURRENT_PROGRAM)
        const loc = gl.getUniformLocation(prog, 'uTime')
        return { t: gl.getUniform(prog, loc), now: performance.now() }
      })()`)
    }
    async function measureRate() {
      const r0 = await sample()
      await sleep(700)
      const r1 = await sample()
      if (!r0 || !r1) return null
      const elapsedS = (r1.now - r0.now) / 1000
      return (r1.t - r0.t) / elapsedS // observed rate: should be ~1 normally, ~0.3 reduced
    }

    await gotoHome(conn)
    await openCase(conn, SLUG)
    await sleep(300)

    const fails = []
    for (const theme of ['dark', 'light']) {
      await setTheme(conn, theme)
      await setReducedMotion(conn, false)
      const normalRate = await measureRate()
      await setReducedMotion(conn, true)
      const reducedRate = await measureRate()
      await setReducedMotion(conn, false)

      const ok =
        normalRate !== null && reducedRate !== null && normalRate > 0.7 && reducedRate < 0.55
      if (!ok) fails.push({ theme, normalRate, reducedRate })
    }
    check(
      '7. prefers-reduced-motion slows the ambient shader (uTime rate), both themes',
      fails.length === 0,
      fails.length ? fails : undefined
    )
  }

  await clearViewport(conn)
  conn.close()
  report()
}

main().catch((err) => {
  console.error(err)
  process.exit(1)
})
