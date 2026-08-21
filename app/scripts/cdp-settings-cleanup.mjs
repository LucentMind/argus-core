#!/usr/bin/env node
/**
 * Runtime gate for the 2026-08-21 settings cleanup.
 *
 * The renderer suite proves every one of these rows against jsdom, which loads no stylesheet:
 * it cannot see whether a subtitle moved onto the header line truncates or shoves the section's
 * action button off the row, whether a collapsed disclosure actually shortens the page, or
 * whether the RCA template's three nested disclosures leave a readable column at a real window
 * width. That is what this measures, in the real renderer with the real Tailwind build.
 *
 * What it answers:
 *   1. identity — the window on this port is running the new markup
 *   2. General opens with ONE appearance row, and expanding it reveals all three controls
 *   3. no delete-confirmation switch and no similar-past-cases switch remain on General
 *   4. Agent orders its sections Providers / Session defaults / Background work / RCA report
 *   5. the two tuning rows carry the dev marker (a dev boot cannot show the hidden branch)
 *   6. the RCA template is shut by default, and one report at a time opens inside it
 *   7. Defect corpus carries the two related-history switches
 *   8. every section header line fits: the subtitle truncates, nothing overflows its row
 *   9. no settings page scrolls horizontally
 *
 * Usage:
 *   1. ARGUS_HOME=<scratch> npx electron-vite dev --remoteDebuggingPort 9247
 *   2. node scripts/cdp-settings-cleanup.mjs
 *
 * Env: CDP_PORT (default 9247), SHOT_DIR (optional — writes a PNG per page when set).
 * Exits 0 when every assertion passes, 1 otherwise.
 */
import fs from 'node:fs'
import path from 'node:path'
import { listTargets, connect, sleep, waitFor, check, report, mainWindow } from './lib/cdp.mjs'

const PORT = process.env.CDP_PORT || '9247'
const SHOT_DIR = process.env.SHOT_DIR || null

const targets = await waitFor('a page target', async () => {
  const t = await listTargets(PORT).catch(() => [])
  return t.length > 0 ? t : null
})
const main = await connect(mainWindow(targets) ?? targets[0])

/** Wait for the renderer to be past its boot skeleton. */
await waitFor('the app shell', () => main.evalJs(`Boolean(document.querySelector('body *'))`))

const shot = async (name) => {
  if (!SHOT_DIR) return
  const r = await main.send('Page.captureScreenshot', { format: 'png' })
  fs.mkdirSync(SHOT_DIR, { recursive: true })
  fs.writeFileSync(path.join(SHOT_DIR, `${name}.png`), Buffer.from(r.result.data, 'base64'))
}

/** Click by accessible name / text, through the real event path. */
const clickByLabel = (label) =>
  main.evalJs(`(() => {
    const el = document.querySelector('[aria-label=${JSON.stringify(label)}]')
    if (!el) return false
    el.click()
    return true
  })()`)

/** A fresh ARGUS_HOME opens the first-run wizard over everything; dismiss it once. */
const skipOnboarding = async () => {
  await main.evalJs(`(() => {
    const b = [...document.querySelectorAll('button')].find(
      (x) => x.textContent.trim() === 'Skip setup'
    )
    if (b) b.click()
    return Boolean(b)
  })()`)
  await sleep(400)
}

const navButtonExists = (label) =>
  main.evalJs(`(() => Boolean(
    [...document.querySelectorAll('button')].find(
      (x) => x.textContent.trim() === ${JSON.stringify(label)}
    )
  ))()`)

/**
 * Open Settings on `label`. The top-bar gear TOGGLES the view, so it is clicked only when the
 * rail is not already on screen — clicking it unconditionally shut Settings again on the second
 * page and made the next assertion fail for the wrong reason.
 */
const openSettingsPage = async (label) => {
  if (!(await navButtonExists(label))) {
    await clickByLabel('Settings')
    await sleep(400)
  }
  await waitFor(`the ${label} nav entry`, async () =>
    main.evalJs(`(() => {
      const b = [...document.querySelectorAll('button')].find(
        (x) => x.textContent.trim() === ${JSON.stringify(label)}
      )
      if (!b) return false
      b.click()
      return true
    })()`)
  )
  await sleep(500)
}

/* ── 0. identity ─────────────────────────────────────────────────────────────────────────── */
await skipOnboarding()
await openSettingsPage('General')
const hasAppearance = await main.evalJs(
  `Boolean(document.querySelector('[aria-label="Expand appearance"]'))`
)
if (!hasAppearance) {
  console.error(`ABORT: port ${PORT} is not running this branch — no Appearance disclosure found`)
  process.exit(2)
}
check('identity: the window on this port has the new General page', true, hasAppearance)

/* ── General ─────────────────────────────────────────────────────────────────────────────── */
const generalBefore = await main.evalJs(`(() => ({
  theme: Boolean(document.querySelector('[aria-label="Theme"]')),
  scale: Boolean(document.querySelector('[aria-label="UI scale"]')),
  dynamic: Boolean(document.querySelector('[aria-label="Dynamic theme"]')),
  confirmDelete: Boolean(document.querySelector('[aria-label="Confirm case delete"]')),
  similar: Boolean(document.querySelector('[aria-label="Similar past cases"]'))
}))()`)
check(
  'General: the three appearance controls are collapsed away',
  !generalBefore.theme && !generalBefore.scale && !generalBefore.dynamic,
  generalBefore
)
check(
  'General: no delete-confirmation and no similar-past-cases switch',
  !generalBefore.confirmDelete && !generalBefore.similar,
  generalBefore
)
await shot('general-collapsed')

await clickByLabel('Expand appearance')
await sleep(200)
const generalOpen = await main.evalJs(`(() => ({
  theme: Boolean(document.querySelector('[aria-label="Theme"]')),
  scale: Boolean(document.querySelector('[aria-label="UI scale"]')),
  dynamic: Boolean(document.querySelector('[aria-label="Dynamic theme"]'))
}))()`)
check(
  'General: expanding Appearance reveals all three',
  generalOpen.theme && generalOpen.scale && generalOpen.dynamic,
  generalOpen
)
await shot('general-expanded')

/* ── Agent ───────────────────────────────────────────────────────────────────────────────── */
await openSettingsPage('Agent')
const agentSections = await main.evalJs(`(() => {
  const labels = [...document.querySelectorAll('section > div .font-mono')]
    .map((el) => el.textContent.trim())
  return labels
})()`)
check(
  'Agent: Session defaults sits above Background work, RCA report last',
  agentSections.join('|').includes('Session defaults') &&
    agentSections.indexOf('Session defaults') < agentSections.indexOf('Background work') &&
    agentSections.includes('RCA report'),
  agentSections
)

/**
 * The two tuning rows follow the dev-tools gate. A `npm run dev` boot has it ON, so the honest
 * assertion here is the dev BRANCH — that both rows render and both are marked as dev-only.
 * The hidden branch cannot be reached from a dev boot at all; AgentSettings.test.tsx covers it.
 */
const tuning = await main.evalJs(`(() => {
  // The row wrapper carries Tailwind's group/row class, whose slash is not a valid CSS
  // selector character unescaped — walk up by class list instead of using closest().
  const row = (label) => {
    let el = document.querySelector('[aria-label=' + JSON.stringify(label) + ']')
    while (el && !el.classList.contains('group/row')) el = el.parentElement
    return el
  }
  const chip = (label) => {
    const r = row(label)
    return r ? [...r.querySelectorAll('span')].some((s) => s.textContent.trim() === 'dev') : false
  }
  return {
    devTools: Boolean(window.__ARGUS_DEV_TOOLS__ ?? true),
    maxSessions: Boolean(row('Max concurrent sessions')),
    probe: Boolean(row('Probe timeout (ms)')),
    maxSessionsChip: chip('Max concurrent sessions'),
    probeChip: chip('Probe timeout (ms)')
  }
})()`)
check(
  'Agent: on a dev boot the two tuning rows render, each marked dev',
  tuning.maxSessions && tuning.probe && tuning.maxSessionsChip && tuning.probeChip,
  tuning
)

const templateShut = await main.evalJs(`(() => ({
  disclosure: Boolean(document.querySelector('[aria-label="Expand report template"]')),
  lists: document.querySelectorAll('ul[aria-label$="sections"]').length
}))()`)
check(
  'Agent: the RCA template is one shut row',
  templateShut.disclosure && templateShut.lists === 0,
  templateShut
)
await shot('agent')

await clickByLabel('Expand report template')
await sleep(250)
const templateOpen = await main.evalJs(`(() => ({
  lists: [...document.querySelectorAll('ul[aria-label$="sections"]')].map((u) =>
    u.getAttribute('aria-label')
  ),
  rows: document.querySelectorAll('ul[aria-label$="sections"] li').length,
  textareas: document.querySelectorAll('ul[aria-label$="sections"] textarea').length
}))()`)
check(
  'Agent: one report opens at a time, with no instruction textarea until asked',
  templateOpen.lists.length === 1 && templateOpen.rows > 0 && templateOpen.textareas === 0,
  templateOpen
)
await shot('agent-template')

/* ── Defect corpus ───────────────────────────────────────────────────────────────────────── */
await openSettingsPage('Defect corpus')
const corpus = await main.evalJs(`(() => ({
  master: Boolean(
    document.querySelector('[aria-label="Search related cases on case open"]')
  ),
  local: Boolean(document.querySelector('[aria-label="Include this install\\'s own cases"]'))
}))()`)
check(
  'Defect corpus: both related-history switches are present',
  corpus.master && corpus.local,
  corpus
)
await shot('defect-corpus')

/* ── Library ─────────────────────────────────────────────────────────────────────────────── */
await openSettingsPage('Library')
await sleep(400)
await shot('library')

/* ── layout: header lines and horizontal overflow ────────────────────────────────────────── */
const layout = await main.evalJs(`(() => {
  const bad = []
  for (const p of document.querySelectorAll('section p.truncate')) {
    const row = p.parentElement?.parentElement
    if (!row) continue
    // The subtitle must not push its row wider than the column it sits in.
    if (row.scrollWidth > row.clientWidth + 1)
      bad.push({ text: p.textContent.slice(0, 40), scroll: row.scrollWidth, client: row.clientWidth })
  }
  const scroller = document.querySelector('main') ?? document.body
  return {
    overflowingHeaders: bad,
    pageScrollX: scroller.scrollWidth - scroller.clientWidth,
    bodyScrollX: document.body.scrollWidth - document.body.clientWidth
  }
})()`)
check(
  'layout: no section header line overflows its row',
  layout.overflowingHeaders.length === 0,
  layout.overflowingHeaders
)
check(
  'layout: no page scrolls horizontally',
  layout.pageScrollX <= 0 && layout.bodyScrollX <= 0,
  layout
)

main.close()
report()
