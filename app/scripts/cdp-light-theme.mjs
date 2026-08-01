#!/usr/bin/env node
/**
 * Light-theme acceptance CAPTURE (spec 2026-08-01-light-theme-redesign-design.md §8, task 11).
 *
 * SCOPE NOTE: this driver captures only — it changes no token, no component, no style. Tasks
 * 1-10 land behind unit tests that can only see class names and CSS source text — jsdom loads no
 * stylesheet, applies no backdrop-filter and composites nothing. This drives the real app over
 * CDP in both themes, both dynamic-theme states, and the editor window, and writes full-window
 * PNGs plus a handful of programmatic checks. A human looks at the PNGs afterward; this script
 * does not tune theme.css.
 *
 * Follows `cdp-dynamic-theme-views.mjs`'s launch and helper pattern exactly: `lib/cdp.mjs`'s
 * `listTargets`/`connect`/`mainWindow`/`waitFor`/`check`/`report`, node 22's global `WebSocket`,
 * no new dependencies. Also borrows `cdp-editor-window.mjs`'s `gotoLibrary`/second-window pattern
 * for the editor capture, and reuses the `dynamicThemeViews.mjs` seed fixture (case `DTV-1-p1`,
 * already migrated + PR-bound + evidence-heavy) rather than inventing a new one.
 *
 * Usage:
 *   1. mkdir -p /tmp/argus-light && ARGUS_HOME=/tmp/argus-light npm run dev   (quit once booted)
 *      ARGUS_HOME=/tmp/argus-light node scripts/seed/dynamicThemeViews.mjs
 *   2. ARGUS_HOME=/tmp/argus-light npx electron-vite dev --remoteDebuggingPort 9223
 *   3. ARGUS_HOME=/tmp/argus-light node scripts/cdp-light-theme.mjs
 *
 * Env: CDP_PORT (default 9223), OUT (default ./light-shots), ARGUS_HOME (required — used to
 * read argus.db directly for the seeded case/session ids, same DB the running app has open).
 *
 * Exits 0 when every check() passes, 1 otherwise. The exit code says nothing about whether the
 * PALETTE looks right — that is what the screenshots and the written report are for.
 *
 * Approval/Question/Mermaid capture technique: these three surfaces are driven by client-side
 * stores (`agentStore`) fed by IPC events from a live agent run. Faking a real approval or a
 * real mermaid-bearing assistant turn would need a working provider + network. Instead this
 * dynamically imports the renderer's OWN `agentStore` module straight from the Vite dev server
 * (`await import('/src/lib/agentStore.ts')`, same origin, same module singleton the mounted
 * React tree already subscribes to — electron-vite's index.html loads `/src/main.tsx`, so
 * everything under `src/renderer/src` is served at its own `/src/...` path) and calls
 * `agentStore.apply(event)` with the same `AgentEvent` shapes main's IPC bridge would deliver.
 * This is a capture technique, not a code change: no source file is touched, and the resulting
 * render is pixel-for-pixel what a real approval/question/diagram turn would produce.
 */
import fs from 'node:fs'
import path from 'node:path'
import zlib from 'node:zlib'
import { DatabaseSync } from 'node:sqlite'
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
const OUT = path.resolve(process.env.OUT || './light-shots')
const HOME = process.env.ARGUS_HOME
const SLUG = 'DTV-1-p1' // dynamicThemeViews.mjs's fixture: P1 case, PR-bound, 200 evidence rows
const listTargets = () => list(PORT)

if (!HOME) throw new Error('ARGUS_HOME is required (read-only access to argus.db for seeded ids)')
fs.mkdirSync(OUT, { recursive: true })

// ── CDP plumbing not already in lib/cdp.mjs (copied from cdp-dynamic-theme-views.mjs) ──────────

async function sendOk(conn, method, params) {
  const r = await conn.send(method, params)
  if (r.error) throw new Error(`${method} failed: ${JSON.stringify(r.error)}`)
  return r.result
}

async function setViewport(conn, width, height) {
  await sendOk(conn, 'Emulation.setDeviceMetricsOverride', {
    width,
    height,
    deviceScaleFactor: 1,
    mobile: false
  })
}

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
    offset += 8 + len + 4
  }
  if (width !== 1 || height !== 1) {
    throw new Error(`expected a 1x1 screenshot, got ${width}x${height}`)
  }
  const raw = zlib.inflateSync(Buffer.concat(idatChunks))
  if (colorType !== 2 && colorType !== 6) throw new Error(`unsupported PNG colorType ${colorType}`)
  return [raw[1], raw[2], raw[3]]
}

async function screenshotPixel(conn, x, y) {
  const r = await sendOk(conn, 'Page.captureScreenshot', {
    format: 'png',
    clip: { x, y, width: 1, height: 1, scale: 1 },
    fromSurface: true
  })
  return decode1x1Png(Buffer.from(r.data, 'base64'))
}

const dist = (a, b) => Math.max(Math.abs(a[0] - b[0]), Math.abs(a[1] - b[1]), Math.abs(a[2] - b[2]))

/** Full-window PNG (the app is a single non-scrolling window, so "full page" === the current
 *  device-metrics viewport — there is no outer document scroll to chase). */
async function shot(conn, name) {
  const r = await sendOk(conn, 'Page.captureScreenshot', { format: 'png', fromSurface: true })
  const file = path.join(OUT, `${name}.png`)
  fs.writeFileSync(file, Buffer.from(r.data, 'base64'))
  console.error(`  shot: ${name}.png`)
  return file
}

// ── page-level helpers (same pattern as cdp-dynamic-theme-views.mjs: element.click() dispatches
// a real bubbling MouseEvent — no Input-domain synthesis needed for a plain click) ──────────────

const clickSelector = (conn, sel) =>
  conn.evalJs(`(() => {
    const el = document.querySelector(${JSON.stringify(sel)})
    if (!el) return false
    el.click()
    return true
  })()`)

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

/** Click the first button anywhere in the document whose visible text STARTS WITH `text`. */
const clickByText = (conn, text) =>
  conn.evalJs(`(() => {
    const btn = [...document.querySelectorAll('button')].find(
      b => (b.textContent || '').trim().startsWith(${JSON.stringify(text)})
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

const openSettings = async (conn) => {
  if (await conn.evalJs(`!!document.querySelector('[data-testid="dynamic-settings"]')`)) return
  await clickSelector(conn, 'button[aria-label="Settings"]')
  await waitFor('settings view', () =>
    conn.evalJs(`!!document.querySelector('[data-testid="dynamic-settings"]')`)
  )
}

const gotoSettingsPage = async (conn, label) => {
  await openSettings(conn)
  await clickByLabel(conn, 'nav[aria-label="Settings sections"]', label)
  await waitFor(`${label} settings page`, () =>
    conn.evalJs(
      `document.querySelector('[data-testid="settings-title"]')?.textContent === ${JSON.stringify(label)}`
    )
  )
}

const openCase = async (conn, slug) => {
  await gotoHome(conn)
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

/** Real mouse move via the Input domain (not a class poke) — the only way to actually enter the
 *  CSS :hover pseudo-class so the composited frame reflects it. */
async function moveMouse(conn, x, y) {
  await sendOk(conn, 'Input.dispatchMouseEvent', { type: 'mouseMoved', x, y })
}

/** Focus an element and type `text` through the real beforeinput/input path (Input.insertText),
 *  same technique the editor gates use for CodeMirror. */
async function typeInto(conn, sel, text) {
  await conn.evalJs(`document.querySelector(${JSON.stringify(sel)})?.focus()`)
  await conn.insertText(text)
}

// ── main ─────────────────────────────────────────────────────────────────────────────────────

async function main() {
  const targets = await listTargets()
  if (targets.length === 0) {
    throw new Error(`no page target on CDP port ${PORT} — is the app running with a debug port?`)
  }
  const conn = await connect(mainWindow(targets) ?? targets[0])
  await setViewport(conn, 1440, 900)

  // ── Force light mode through uiStore's actual persisted key (lib/uiStore.ts KEYS.theme =
  // 'argus.ui.theme'), then reload — per the brief, not guessed. ──
  await conn.evalJs(`localStorage.setItem('argus.ui.theme', 'light')`)
  await sendOk(conn, 'Page.reload', {})
  await waitFor('app to reboot in light mode', () =>
    conn
      .evalJs(`document.readyState === 'complete' && document.documentElement.getAttribute('data-theme')`)
      .then((v) => v === 'light')
      .catch(() => false)
  )
  await gotoHome(conn)
  console.error('forced light mode + reload: ok')

  // Read the seeded case/session ids straight from argus.db — the same file the running app has
  // open — rather than re-deriving them through the UI. Read-only: no writes from this script.
  const dbPath = path.join(HOME, 'argus.db')
  const db = new DatabaseSync(dbPath, { readOnly: true })
  const caseRow = db.prepare('SELECT id, slug FROM cases WHERE slug = ?').get(SLUG)
  if (!caseRow) throw new Error(`fixture case ${SLUG} not found in ${dbPath} — run the seed script first`)
  const sessionRow = db
    .prepare('SELECT id FROM sessions WHERE case_id = ? ORDER BY id DESC LIMIT 1')
    .get(caseRow.id)
  if (!sessionRow) throw new Error(`no session for case ${SLUG} — run the seed script first`)
  const CASE_ID = caseRow.id
  const SESSION_ID = sessionRow.id
  db.close()
  console.error(`fixture ids: caseId=${CASE_ID} sessionId=${SESSION_ID}`)

  // ── 1. Core matrix: home / case / settings x {light+dynOff, light+dynOn, dark+dynOn}. ──
  await setDynamicTheme(conn, false)
  await gotoHome(conn)
  await sleep(300)
  await shot(conn, '01-home-light-dynOff')
  await openCase(conn, SLUG)
  await sleep(300)
  await shot(conn, '02-case-light-dynOff')
  await gotoSettingsPage(conn, 'General')
  await sleep(200)
  await shot(conn, '03-settings-light-dynOff')

  await setDynamicTheme(conn, true)
  await gotoHome(conn)
  await sleep(700) // let AmbientCanvas's first refresh()/rAF run
  await shot(conn, '04-home-light-dynOn')
  await openCase(conn, SLUG)
  await sleep(700)
  await shot(conn, '05-case-light-dynOn')
  await gotoSettingsPage(conn, 'General')
  await sleep(400)
  await shot(conn, '06-settings-light-dynOn')

  await setTheme(conn, 'dark')
  await gotoHome(conn)
  await sleep(700)
  await shot(conn, '07-home-dark-dynOn')
  await openCase(conn, SLUG)
  await sleep(700)
  await shot(conn, '08-case-dark-dynOn')
  await gotoSettingsPage(conn, 'General')
  await sleep(400)
  await shot(conn, '09-settings-dark-dynOn')

  // ── Prediction #1 supporting evidence: sample the composited pixel just above/below the
  // AmbientCanvas's own bottom edge on home/case/settings, dynamic ON, both themes, and print the
  // colour distance. Not a check() — this documents a KNOWN FINDING for the report, it does not
  // gate the exit code (the whole task is to observe this, not assert it away). ──
  for (const theme of ['light', 'dark']) {
    await setTheme(conn, theme)
    for (const [view, opener] of [
      ['home', gotoHome],
      ['case', (c) => openCase(c, SLUG)],
      ['settings', (c) => gotoSettingsPage(c, 'General')]
    ]) {
      await opener(conn)
      await sleep(400)
      const canvasRect = await rect(conn, `[data-testid="dynamic-${view}"] canvas.dyn-ambient`)
      if (!canvasRect) {
        console.error(`  [canvas-seam] ${theme}/${view}: no canvas.dyn-ambient found`)
        continue
      }
      const x = Math.round(canvasRect.left + canvasRect.width / 2)
      const above = await screenshotPixel(conn, x, Math.max(0, Math.round(canvasRect.bottom - 1)))
      const below = await screenshotPixel(conn, x, Math.round(canvasRect.bottom + 1))
      console.error(
        `  [canvas-seam] ${theme}/${view}: bottom=${Math.round(canvasRect.bottom)} above=${JSON.stringify(above)} below=${JSON.stringify(below)} dist=${dist(above, below)}`
      )
    }
  }
  await setTheme(conn, 'light')
  await setDynamicTheme(conn, true)

  // ── 2. Card hover on home (light, dynamic on): real mouse-move to the last .glass-card. ──
  await gotoHome(conn)
  await sleep(500)
  {
    const target = await conn.evalJs(`(() => {
      const cards = [...document.querySelectorAll('.glass-card')]
      const c = cards[cards.length - 1]
      if (!c) return null
      const r = c.getBoundingClientRect()
      return { x: Math.round(r.left + r.width / 2), y: Math.round(r.top + r.height / 2) }
    })()`)
    if (target) {
      await moveMouse(conn, target.x, target.y)
      await sleep(300)
      await shot(conn, '10-home-card-hover-light-dynOn')
    } else {
      console.error('  no .glass-card found on home to hover (dynamic theme may not be on)')
    }
  }

  // ── 3. New-case dialog (light). ──
  await gotoHome(conn)
  await clickByText(conn, 'New case')
  await waitFor('New case dialog', () => conn.evalJs(`!!document.querySelector('[data-testid="modal-backdrop"]')`))
  await sleep(200)
  await shot(conn, '11-new-case-dialog-light')
  await clickSelector(conn, 'button[aria-label="Close"]')
  await sleep(200)

  // ── 4. MenuButton dropdown (light) — the status filter on the home dashboard. ──
  await gotoHome(conn)
  await clickSelector(conn, 'button[aria-haspopup="menu"]')
  await waitFor('a menu is open', () => conn.evalJs(`!!document.querySelector('[role="menu"]')`))
  await sleep(150)
  await shot(conn, '12-menu-dropdown-light')
  await clickSelector(conn, 'button[aria-haspopup="menu"]') // toggle closed
  await sleep(150)

  // ── 5. Composer's "/" skills popup (light) — same visual family as #4; the report compares
  // them directly. ──
  await openCase(conn, SLUG)
  await sleep(400)
  await typeInto(conn, 'textarea[placeholder^="Message the analyst"]', '/')
  const popupShown = await waitFor(
    'skills popup (or confirmation none matched)',
    () => conn.evalJs(`document.querySelector('textarea[placeholder^="Message the analyst"]')?.value === '/'`),
    5000
  ).catch(() => false)
  await sleep(200)
  await shot(conn, '13-composer-slash-popup-light')
  if (!popupShown) console.error('  composer text did not update to "/" — popup shot may be empty')
  // clean the composer back to empty
  await conn.evalJs(`(() => {
    const ta = document.querySelector('textarea[placeholder^="Message the analyst"]')
    if (!ta) return
    const setter = Object.getOwnPropertyDescriptor(window.HTMLTextAreaElement.prototype, 'value').set
    setter.call(ta, '')
    ta.dispatchEvent(new Event('input', { bubbles: true }))
  })()`)
  await sleep(100)

  // ── 6. Settings pages with text inputs (light): General, Agent, Memory (textarea), Library
  // (search box). ──
  await gotoSettingsPage(conn, 'General')
  await sleep(200)
  await shot(conn, '14-settings-general-light')
  await gotoSettingsPage(conn, 'Agent')
  await sleep(300)
  await shot(conn, '15-settings-agent-light')
  await gotoSettingsPage(conn, 'Memory')
  await sleep(300)
  await shot(conn, '16-settings-memory-light')
  await gotoSettingsPage(conn, 'Library')
  await sleep(300)
  await typeInto(conn, 'input[placeholder="Search names and reference content…"]', 'skill')
  await sleep(200)
  await shot(conn, '17-settings-library-search-light')

  // ── 7. ApprovalCard / QuestionCard / Mermaid lightbox (light) — via agentStore.apply, see the
  // module doc comment for why this is a capture technique and not a code change. ──
  await openCase(conn, SLUG)
  await sleep(400)
  const agentStoreOk = await conn.evalJs(`(async () => {
    try {
      const mod = await import('/src/lib/agentStore.ts')
      window.__agentStoreForCapture = mod.agentStore
      return typeof mod.agentStore?.apply === 'function'
    } catch (e) {
      window.__agentStoreImportError = String(e && e.stack || e)
      return false
    }
  })()`)
  if (!agentStoreOk) {
    const err = await conn.evalJs(`window.__agentStoreImportError || 'unknown'`)
    console.error(`  could not import agentStore for capture — skipping approval/question/mermaid: ${err}`)
  } else {
    const base = (type, payload) =>
      `{ eventId: crypto.randomUUID(), caseId: ${CASE_ID}, caseSlug: ${JSON.stringify(SLUG)}, sessionId: ${SESSION_ID}, turnId: null, ts: new Date().toISOString(), type: ${JSON.stringify(type)}, payload: ${JSON.stringify(payload)} }`

    // 7a. ApprovalCard — HIGH risk, no editable-input path, matches the pre-existing production shape.
    await conn.evalJs(
      `window.__agentStoreForCapture.apply(${base('request.opened', {
        requestId: 'capture-approval-1',
        tool: 'Bash',
        risk: 'HIGH',
        grantKey: null,
        argsPreview: 'rm -rf /tmp/scratch-build-artifacts'
      })})`
    )
    await waitFor('ApprovalCard rendered', () => conn.evalJs(`!!document.querySelector('.text-danger, .border-danger\\\\/40')`)).catch(() => {})
    await sleep(300)
    await shot(conn, '18-approval-card-light')
    await conn.evalJs(
      `window.__agentStoreForCapture.apply(${base('request.resolved', { requestId: 'capture-approval-1', decision: 'cancelled' })})`
    )

    // 7b. QuestionCard — two questions, one single-select, one multi-select.
    await conn.evalJs(
      `window.__agentStoreForCapture.apply(${base('dialog.opened', {
        dialogId: 'capture-dialog-1',
        questions: [
          {
            question: 'Which environment did the regression reproduce in?',
            header: 'Environment',
            multiSelect: false,
            options: [
              { label: 'staging', description: 'shared staging cluster' },
              { label: 'prod-mirror', description: 'read replica of prod' }
            ]
          },
          {
            question: 'Which checks should the fix re-run?',
            header: 'CI',
            multiSelect: true,
            options: [
              { label: 'unit-tests', description: '' },
              { label: 'verify-a / verify', description: '' }
            ]
          }
        ]
      })})`
    )
    await sleep(300)
    await shot(conn, '19-question-card-light')
    await conn.evalJs(
      `window.__agentStoreForCapture.apply(${base('dialog.resolved', { dialogId: 'capture-dialog-1', behavior: 'cancelled' })})`
    )
    await sleep(200)

    // 7c. Mermaid block + lightbox.
    await conn.evalJs(
      `window.__agentStoreForCapture.apply(${base('assistant.message', {
        text:
          'Here is the flow:\n\n```mermaid\ngraph TD\n  A[Ingest evidence] --> B{P1?}\n  B -- yes --> C[Notify on-call]\n  B -- no --> D[Queue for triage]\n  C --> E[Open case]\n  D --> E\n```\n'
      })})`
    )
    const mermaidOk = await waitFor(
      'mermaid diagram rendered',
      () => conn.evalJs(`!!document.querySelector('[aria-label="Expand diagram"]')`),
      10000
    ).catch(() => false)
    if (mermaidOk) {
      await conn.evalJs(
        `document.querySelector('[aria-label="Expand diagram"]').scrollIntoView({ block: 'center' })`
      )
      await sleep(200)
      await clickSelector(conn, '[aria-label="Expand diagram"]')
      await waitFor('mermaid lightbox open', () =>
        conn.evalJs(`!!document.querySelector('[role="dialog"][aria-label="Diagram"]')`)
      )
      await sleep(200)
      await shot(conn, '20-mermaid-lightbox-light')
      await conn.evalJs(
        `window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }))`
      )
      await sleep(150)
    } else {
      console.error('  mermaid block never reached phase "ok" — skipping lightbox shot')
    }
  }

  // ── Editor window: light, then dark (theme is broadcast cross-window). ──
  await setTheme(conn, 'light')
  const gotoLibrary = async (main) => {
    await waitFor(
      'the Library page with a user-tier Edit button',
      async () => {
        if (await main.evalJs(`!!document.querySelector('[aria-label^="Edit \\u00b7 "]')`)) return true
        await main.evalJs(`(() => {
          const gear = document.querySelector('button[aria-label="Settings"]')
          if (gear && !document.querySelector('nav[aria-label="Settings sections"]')) gear.click()
          const nav = document.querySelector('nav[aria-label="Settings sections"]')
          const lib = nav && [...nav.querySelectorAll('button')].find(b => (b.textContent || '').trim() === 'Library')
          if (lib) lib.click()
          return 1
        })()`)
        return false
      },
      30000
    )
  }
  await gotoLibrary(conn)
  await conn.evalJs(`document.querySelector('[aria-label^="Edit \\u00b7 "]').click()`)
  const editorTarget = await waitFor('editor window', async () => {
    const now = await listTargets()
    return now.find((t) => t.url.includes('editor.html')) ?? null
  }).catch(() => null)

  let editor = null
  if (!editorTarget) {
    console.error('  editor window never appeared — no editor screenshots or editor checks')
  } else {
    editor = await connect(editorTarget)
    await waitFor('editor renders an asset', () => editor.evalJs(`!!document.querySelector('.cm-content')`))
    await sleep(400)
    await shot(editor, '21-editor-light')
    await setTheme(conn, 'dark')
    await sleep(400)
    await shot(editor, '22-editor-dark')
    await setTheme(conn, 'light')
  }

  // ── Programmatic checks. ──

  // 1a/1b. body's computed background carries the wash, in BOTH windows.
  const bodyBg = (c) =>
    c.evalJs(
      `(() => { const cs = getComputedStyle(document.body); return { image: cs.backgroundImage, attachment: cs.backgroundAttachment } })()`
    )
  // backgroundAttachment reports one value PER background-image layer (the wash stacks a
  // linear-gradient under two radial-gradients), so it comes back as "fixed, fixed, fixed" —
  // not the literal string 'fixed'. Every layer must be fixed for the anchoring guarantee to hold.
  const allFixed = (attachment) => attachment.split(',').every((a) => a.trim() === 'fixed')
  const mainBg = await bodyBg(conn)
  check(
    '1a. main window body background: linear-gradient + fixed attachment (light)',
    mainBg.image.includes('linear-gradient') && allFixed(mainBg.attachment),
    mainBg
  )
  if (editor) {
    const editorBg = await bodyBg(editor)
    check(
      '1b. editor window body background: linear-gradient + fixed attachment (light)',
      editorBg.image.includes('linear-gradient') && allFixed(editorBg.attachment),
      editorBg
    )
  } else {
    check('1b. editor window body background', false, 'editor window never opened')
  }

  // 2. .surface-card box-shadow is not 'none' in light.
  const surfaceShadow = await conn.evalJs(`(() => {
    const el = document.querySelector('.surface-card')
    return el ? getComputedStyle(el).boxShadow : null
  })()`)
  check(
    "2. a .surface-card's computed box-shadow is not 'none' in light",
    !!surfaceShadow && surfaceShadow !== 'none',
    surfaceShadow
  )

  // 3. .glass-card backdrop-filter contains 'blur' in light (dynamic must be on for one to exist).
  await setDynamicTheme(conn, true)
  await gotoHome(conn)
  await sleep(500)
  const glassFilter = await conn.evalJs(`(() => {
    const el = document.querySelector('.glass-card')
    return el ? getComputedStyle(el).backdropFilter : null
  })()`)
  check(
    "3. a .glass-card's computed backdrop-filter contains 'blur' in light",
    !!glassFilter && glassFilter.includes('blur'),
    glassFilter
  )

  // 4. seam check at a container boundary: the TopBar's own bottom edge, light, dynamic OFF (the
  // wash itself, isolated from the AmbientCanvas complication documented above). TopBar.tsx
  // renders exactly one <header> (CaseWorkspace's own <header> only mounts inside a case, not on
  // home) — target it by TAG, not by a `.border-b` class guess that can match an unrelated
  // hairline first in DOM order.
  await setDynamicTheme(conn, false)
  await gotoHome(conn)
  await sleep(300)
  {
    const useRect = await rect(conn, 'header')
    if (useRect) {
      const x = Math.round(useRect.left + Math.min(60, useRect.width / 2))
      const yAbove = Math.max(0, Math.round(useRect.bottom - 1))
      const yBelow = Math.round(useRect.bottom + 1)
      const above = await screenshotPixel(conn, x, yAbove)
      const below = await screenshotPixel(conn, x, yBelow)
      const d = dist(above, below)
      const seamDetail = { headerRect: useRect, x, yAbove, yBelow, above, below, distance: d }
      check(
        '4. wash does not jump at the TopBar boundary (light, dynamic off, <3/255 per channel)',
        d < 3,
        seamDetail
      )
    } else {
      check('4. wash does not jump at the TopBar boundary', false, 'TopBar <header> not found')
    }
  }

  editor?.close()
  conn.close()
  report()
}

main().catch((err) => {
  console.error(err)
  process.exit(1)
})
