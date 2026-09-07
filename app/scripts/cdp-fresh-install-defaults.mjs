#!/usr/bin/env node
/**
 * Fresh-install model defaults — live gate (spec 2026-09-07-fresh-install-model-defaults).
 *
 * Drives the REAL app over CDP against an EMPTY scratch ARGUS_HOME (no preferences, no
 * explicit distillation model) and reads what a pristine user actually gets:
 *
 *   1. a brand-new case's composer Model chip reads "Claude Opus 5" — the static row 0 seed
 *      (`defaultModelRef`) reaching the real session row and the real chip, not a unit test's
 *      view of `orderedVisibleModels`;
 *   2. Settings → Distillation's model select reads "Automatic (claude-sonnet-5)" — the pinned
 *      `distillOk` default surfacing through the resolver the section derives its label from.
 *
 * jsdom proves the functions; this proves the wiring (registry seed → sessions row → chip, and
 * resolver → IPC payload → SelectField) with the bundled CLI catalog actually loaded, which is
 * the one condition the unit tests cannot create: a live catalog whose `opus[1m]` alias row
 * dedupes the static Opus 5 row and could, if the naming or pinning regressed, relabel the chip.
 *
 * Usage:
 *   ARGUS_HOME=<empty dir> npx electron-vite dev --remoteDebuggingPort <port>
 *   CDP_PORT=<port> node scripts/cdp-fresh-install-defaults.mjs
 *
 * Identity gate (port-collision trap, see the repo notes): the scratch home must have NO cases
 * before we create ours, and the case list must contain only ours afterwards — otherwise the
 * port belongs to another instance and every assertion would be about the wrong app.
 */
import { listTargets, connect, mainWindow, sleep, waitFor, check, report } from './lib/cdp.mjs'

const PORT = process.env.CDP_PORT || '9241'
const SLUG = 'fresh-install-defaults-gate'
const TITLE = 'Fresh-install defaults gate'

const targets = await waitFor(
  'a page target',
  async () => {
    const t = await listTargets(PORT).catch(() => [])
    return t.length > 0 ? t : null
  },
  120000
)
const conn = await connect(mainWindow(targets))

// ── 0. identity: an empty home, or one holding only our own case ──
await waitFor('renderer ready', () => conn.evalJs(`Boolean(window.argus?.cases?.list)`))
const existing = await conn.evalJs(`window.argus.cases.list().then((cs) => cs.map((c) => c.slug))`)
if (existing.some((s) => s !== SLUG)) {
  console.error(`port ${PORT} is another instance's app (cases: ${existing.join(', ')}) — abort`)
  process.exit(2)
}

// ── 1. a new case, opened, its composer chip ──
if (!existing.includes(SLUG)) {
  await conn.evalJs(
    `window.argus.cases.create(${JSON.stringify({ slug: SLUG, title: TITLE })}).then(() => true)`
  )
}
// Always reload: a previous run may have left the window on Settings, where no case card is
// rendered. The main window tolerates a reload (only editor.html does not).
await conn.send('Page.reload', { ignoreCache: true })
await sleep(3000)
await waitFor('case card', () =>
  conn.evalJs(
    `[...document.querySelectorAll('[data-testid="case-title"]')].some((e) => e.textContent.includes(${JSON.stringify(TITLE)}))`
  )
)
await conn.evalJs(
  `[...document.querySelectorAll('[data-testid="case-title"]')].find((e) => e.textContent.includes(${JSON.stringify(TITLE)})).click()`
)
await waitFor('composer', () =>
  conn.evalJs(`Boolean(document.querySelector('textarea[placeholder*="Message the analyst"]'))`)
)
const sessions = await conn.evalJs(`window.argus.sessions.list(${JSON.stringify(SLUG)})`)
check('case has a session after opening', sessions.length >= 1, JSON.stringify(sessions[0]))
check(
  'session row is pinned to claude-opus-5 (the registry seed)',
  sessions[0]?.model === 'claude-opus-5',
  `model=${sessions[0]?.model}`
)
// Let the live catalog land: the chip is derived from the merged rows, and the assertion is
// about the LABEL under a loaded catalog (row dedupe + naming), not the pre-catalog fallback.
await sleep(4000)
const chip = await conn.evalJs(
  `document.querySelector('[data-composer-model]')?.textContent.replace(/\\s+/g, ' ').trim() ?? ''`
)
check('composer Model chip reads Claude Opus 5', chip.includes('Claude Opus 5'), `chip="${chip}"`)

// ── 2. Settings → Distillation ──
const clickButtonByText = (label) =>
  conn.evalJs(
    `(() => { const b = [...document.querySelectorAll('button')].find((x) => x.textContent.trim() === ${JSON.stringify(label)}); if (!b) return false; b.click(); return true })()`
  )
const clickByAriaLabel = (label) =>
  conn.evalJs(
    `(() => { const b = document.querySelector('button[aria-label=' + ${JSON.stringify(JSON.stringify(label))} + ']'); if (!b) return false; b.click(); return true })()`
  )
// The Distillation section lives on the Agent settings page (there is no nav entry of its
// own). The gear TOGGLES Settings, so it is clicked only when the rail is not already up.
const navExists = () =>
  conn.evalJs(
    `Boolean([...document.querySelectorAll('button')].find((x) => x.textContent.trim() === 'Agent'))`
  )
if (!(await navExists())) {
  await waitFor('the Settings gear', () => clickByAriaLabel('Settings'))
  await sleep(600)
}
await waitFor('the Agent settings nav entry', () => clickButtonByText('Agent'))
await sleep(800)
// `SelectField` renders a BUTTON carrying the aria-label, with the current choice as its text
// (not a native <select> with a value) — measured live 2026-09-08.
const fieldText = (label) =>
  conn.evalJs(
    `document.querySelector('[aria-label=' + ${JSON.stringify(JSON.stringify(label))} + ']')?.textContent.trim() ?? null`
  )
const distillModel = await waitFor('the Distillation model field', () =>
  fieldText('Distillation model')
)
check(
  'Distillation model reads Automatic (claude-sonnet-5)',
  distillModel === 'Automatic (claude-sonnet-5)',
  `text="${distillModel}"`
)
const distillProvider = await fieldText('Distillation provider')
check(
  'Distillation provider is Automatic',
  /^Automatic/.test(distillProvider ?? ''),
  distillProvider
)

report()
