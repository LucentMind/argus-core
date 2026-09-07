#!/usr/bin/env node
/**
 * Live gate for the compaction/context-gauge fix (normalize.ts + agentStore.ts + SessionChips +
 * ChatPane notice row + the composer's CLI slash rows).
 *
 * jsdom proved the reducer and the markup against HAND-WRITTEN message shapes. This drives the
 * real app against the real Claude CLI, so it exercises the shapes the SDK actually emits for
 * `/context` (a `<synthetic>` zero-usage assistant message) and `/compact` (status →
 * compact_boundary, no assistant message) — the two things that produced the original bug
 * (gauge stuck on the pre-compact figure, then 0%).
 *
 * It spends real tokens: three short artificial turns to give the CLI something to compact,
 * then /context, /compact, and one more turn to see the gauge recover.
 *
 * Usage:
 *   1. A scratch home whose config/settings.json marks onboarding complete.
 *   2. ARGUS_HOME=<home> npx electron-vite dev --remoteDebuggingPort 9247   (from app/)
 *   3. CDP_PORT=9247 node scripts/cdp-compaction-gauge.mjs
 * Exits 0 when every check passes, 1 otherwise. Screenshots land next to the log in OUT_DIR.
 */
import fs from 'node:fs'
import path from 'node:path'
import { listTargets, connect, mainWindow, sleep, waitFor, check, report } from './lib/cdp.mjs'

const PORT = process.env.CDP_PORT || '9247'
const OUT_DIR = process.env.OUT_DIR || process.cwd()
const SLUG = 'CMP-1-compaction-live'
const TITLE = 'Compaction gauge live gate'

const conn = await connect(mainWindow(await listTargets(PORT)))

const shot = async (name) => {
  const r = await conn.send('Page.captureScreenshot', { format: 'png' })
  const p = path.join(OUT_DIR, `${name}.png`)
  fs.writeFileSync(p, Buffer.from(r.result.data, 'base64'))
  console.log(`  [shot] ${p}`)
}

const CHIP = `document.querySelector('[data-testid="session-chips"] button[aria-label="Session status"]')`
const chipTitle = () => conn.evalJs(`${CHIP}?.title ?? ''`)
const gaugeWidth = () =>
  conn.evalJs(`document.querySelector('[data-testid="context-gauge"]')?.style.width ?? null`)
const lastAssistantText = () =>
  conn.evalJs(
    `(() => { const els = [...document.querySelectorAll('[data-item-index]')]; const a = els.filter(e => e.className.includes('mr-6')); return a.length ? a[a.length-1].innerText : '' })()`
  )
const notices = () =>
  conn.evalJs(
    `[...document.querySelectorAll('[data-testid="session-notice"]')].map(n => ({ kind: n.dataset.kind, text: n.innerText }))`
  )
// The composer swaps Send for Stop while a turn runs — the one DOM signal that tracks
// `state.running` exactly (ThinkingIndicator unmounts as soon as anything streams).
const running = () => conn.evalJs(`Boolean(document.querySelector('button[aria-label="Stop"]'))`)

// ── 0. identity: this must be OUR scratch home (an empty case list, or only our own case) ──
await waitFor('renderer ready', () => conn.evalJs(`Boolean(window.argus?.cases?.list)`))
const existing = await conn.evalJs(`window.argus.cases.list().then(cs => cs.map(c => c.slug))`)
if (existing.some((s) => s !== SLUG)) {
  console.error(`port ${PORT} is another instance's app (cases: ${existing.join(', ')}) — abort`)
  process.exit(2)
}

// ── 1. a case with one Claude session, opened in the UI ──
if (!existing.includes(SLUG)) {
  await conn.evalJs(
    `window.argus.cases.create(${JSON.stringify({ slug: SLUG, title: TITLE })}).then(() => true)`
  )
  await conn.send('Page.reload', { ignoreCache: true })
  await sleep(3000)
}
await waitFor('case card', () =>
  conn.evalJs(
    `[...document.querySelectorAll('[data-testid="case-title"]')].some(e => e.textContent.includes(${JSON.stringify(TITLE)}))`
  )
)
await conn.evalJs(
  `[...document.querySelectorAll('[data-testid="case-title"]')].find(e => e.textContent.includes(${JSON.stringify(TITLE)})).click()`
)
await waitFor('composer', () =>
  conn.evalJs(`Boolean(document.querySelector('textarea[placeholder*="Message the analyst"]'))`)
)
const sessions = await conn.evalJs(`window.argus.sessions.list(${JSON.stringify(SLUG)})`)
check('case has a session after opening', sessions.length >= 1, JSON.stringify(sessions[0]))
const sessionId = sessions[0].id
check(
  'session driver is Claude',
  sessions[0].driverKind === 'claude-agent-sdk',
  sessions[0].driverKind
)
await waitFor(
  'session chip ready',
  async () => /ready/i.test(await conn.evalJs(`${CHIP}?.innerText ?? ''`)),
  60000
)

// ── 2. the composer's slash picker offers the CLI commands, tagged ──
const setComposer = (v) =>
  conn.evalJs(
    `(() => { const t = document.querySelector('textarea[placeholder*="Message the analyst"]'); const s = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value').set; s.call(t, ${JSON.stringify(v)}); t.dispatchEvent(new Event('input', { bubbles: true })); return true })()`
  )
await setComposer('/co')
await sleep(300)
// textContent, not innerText: the CLI tag is `uppercase` in CSS and the rows are flex, so
// innerText's rendered whitespace/casing is not what the markup says.
const popup = await conn.evalJs(
  `[...document.querySelectorAll('button')].map(b => b.textContent.replace(/\\s+/g,' ').trim()).filter(t => t.startsWith('/compact') || t.startsWith('/context'))`
)
check('picker lists /compact and /context', popup.length === 2, JSON.stringify(popup))
check(
  'both rows carry the CLI tag',
  popup.every((t) => /\bCLI\b/.test(t)),
  JSON.stringify(popup)
)
await shot('01-picker')
await setComposer('')

// ── 3. an artificial transcript, so there is something to compact ──
const send = (text) =>
  conn.evalJs(
    `window.argus.agent.send(${JSON.stringify(SLUG)}, ${sessionId}, ${JSON.stringify(text)}).then(() => true)`
  )
const settle = async (label) => {
  await sleep(1500)
  await waitFor(`${label}: turn finished`, async () => !(await running()), 180000)
  await sleep(800)
}
const TOPICS = ['rivers', 'mountains', 'deserts']
for (const t of TOPICS) {
  await send(`Write four sentences about ${t}. Do not use any tools.`)
  await settle(t)
}
const pct = (title) => Number((/context (\d+)% full/.exec(title) ?? [])[1] ?? NaN)
const before = pct(await chipTitle())
check(
  'gauge shows a real level after the transcript',
  Number.isFinite(before) && before > 0,
  `title=${await chipTitle()}`
)
const widthBefore = await gaugeWidth()
await shot('02-before-context')

// ── 4. /context: synthetic zero-usage reply must NOT zero the gauge ──
await send('/context')
await waitFor('/context reply', async () => /Context Usage/i.test(await lastAssistantText()), 60000)
await sleep(1000)
const afterContext = pct(await chipTitle())
check('/context reply rendered as text', /Context Usage/i.test(await lastAssistantText()))
check(
  'gauge did NOT drop to 0% on /context',
  afterContext === before,
  `before=${before}% after=${afterContext}% width=${await gaugeWidth()} (was ${widthBefore})`
)
await shot('03-after-context')

// ── 5. /compact: notice while running, then "compacted" state with no stale gauge ──
await send('/compact')
await waitFor(
  'compacting notice',
  async () => (await notices()).some((n) => n.kind === 'compacting'),
  30000
)
check('compacting notice shown while the CLI works', true)
await shot('04-compacting')
await waitFor(
  'compacted notice',
  async () => (await notices()).some((n) => n.kind === 'compacted' || n.kind === 'compact_failed'),
  120000
)
const ns = await notices()
const outcome = ns[ns.length - 1]
check(
  'compaction succeeded (not "not enough messages")',
  outcome.kind === 'compacted',
  JSON.stringify(ns)
)
check(
  'outcome replaced the compacting row (no stacking)',
  !ns.some((n) => n.kind === 'compacting'),
  JSON.stringify(ns)
)
check(
  'compacted notice names the pre-compaction size',
  /\d{1,3}(,\d{3})+ tokens/.test(outcome.text),
  outcome.text
)
await sleep(1000)
check(
  'gauge hidden after compaction (level unknown)',
  (await gaugeWidth()) === null,
  `width=${await gaugeWidth()}`
)
check(
  'chip title no longer claims the stale percentage',
  !/context \d+% full/.test(await chipTitle()),
  await chipTitle()
)
await conn.evalJs(`${CHIP}.click()`)
await sleep(300)
const popover = await conn.evalJs(`document.querySelector('[role="dialog"]')?.innerText ?? ''`)
check(
  'popover says compacted — updates next turn',
  /compacted/i.test(popover) && /next turn/i.test(popover),
  popover.replace(/\s+/g, ' ').slice(0, 200)
)
await shot('05-compacted')
await conn.evalJs(`${CHIP}.click()`)

// ── 6. the next real turn restores a (smaller) level ──
await send('Reply with the single word done. Do not use any tools.')
await settle('post-compact turn')
const after = pct(await chipTitle())
check(
  'gauge back after the next turn',
  Number.isFinite(after) && after > 0,
  `after=${after}% title=${await chipTitle()}`
)
// Not "lower than before": measured live, the first post-compaction call was LARGER (the
// summary plus the preserved tail on top of the unchanged system prompt), and on a 1M window
// the rounded percentage cannot move anyway. What matters is that a real level is back.
//
// The CLI replays the preserved tail after the boundary with the SAME uuids (captured
// 2026-09-07); the driver must drop those, so the /context report appears exactly once.
const reports = await conn.evalJs(
  `[...document.querySelectorAll('[data-item-index]')].filter(e => /Context Usage/.test(e.innerText)).length`
)
check(
  'the /context report is rendered exactly once (replay after compaction deduped)',
  reports === 1,
  `count=${reports}`
)
await conn.evalJs(`${CHIP}.click()`)
await sleep(300)
const popover2 = await conn.evalJs(`document.querySelector('[role="dialog"]')?.innerText ?? ''`)
check(
  'popover shows a percentage again, not "compacted"',
  /\d+% of/.test(popover2) && !/compacted/i.test(popover2),
  popover2.replace(/\s+/g, ' ').slice(0, 200)
)
await shot('06-recovered')
await conn.evalJs(`${CHIP}.click()`)

conn.close()
report()
