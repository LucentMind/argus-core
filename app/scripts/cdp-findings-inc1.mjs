#!/usr/bin/env node
/**
 * Findings increment 1 live exit-check (plan 2026-10-26-findings-inc1-review-in-chat.md, Task 13
 * step 3) — drives the REAL app over CDP against a scratch ARGUS_HOME with a REAL Claude chat
 * session (two short turns), the OTLP provider pointed at a local receiver for the score
 * read-back, and the headless runners replaced by the fake (never reached: no distill here).
 *
 * Flow (self-boot; helpers in scripts/lib/fakeBoot.mjs):
 *   0. receiver on 127.0.0.1:<any>; scratch home whose settings pin bypassPermissions (a read
 *      turn must not park on an approval card) and enable ONLY the OTLP provider; boot on a free
 *      CDP port in 9260-9290; identity gate (exit 2 on a mismatch — argus-cdp-port-collision).
 *   1. create the case + a session pinned to GATE_MODEL (default claude-opus-5: a fresh home seeds
 *      a model the SDK's bundled CLI rejects), ingest one evidence file, open the case.
 *   2. turn 1 asks the agent to record exactly ONE finding. Exit 2 if the turn errors (every
 *      later check would describe an error stub). Expect: one investigation finding in the DB;
 *      the transcript shows it as an inline finding card (thumbs present) and NO
 *      `argus:append_finding` tool row, while other `argus:` tool rows (the evidence read) are
 *      still plain tool cards.
 *   3. thumbs-down on the INLINE card → DB rejected/human, no tag; the reason strip is open under
 *      the inline card; the rail's card for the same finding is red too (shared store).
 *   4. type a note, click `Wrong` → DB tag=wrong + note; strip closed; BOTH cards show `Wrong` and
 *      the note.
 *   5. turn 2 ("Continue") → the transcript's user bubble and the mirror's `turn.started` carry
 *      the raw text (driver-only delta); the reply acknowledges the rejection; the finding was
 *      not re-recorded under the same title.
 *   6. tool cards off (localStorage) + reload + reopen → the finding card is still there
 *      (hydrated from the persisted tool result), with no tool rows at all.
 *   7. score read-back: every `evaluation finding_accepted` span the receiver saw carries ONE
 *      `argus.score.id` (upsert id), and the latest carries tag=wrong, actor=human.
 *
 * Not covered here (unit-tested instead): review-mode cards (need a linked repo + PR),
 * `list_findings` rendering the tag, the attribution override from a `wrong` note.
 *
 * Usage:  cd app && GATE_MODEL=claude-opus-5 node scripts/cdp-findings-inc1.mjs
 * Exits 0 when every check passes, 1 when any fails, 2 on an abort.
 */
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { sleep, waitFor, check, report } from './lib/cdp.mjs'
import {
  BOOT_TIMEOUT_MS,
  abort,
  installTeardown,
  freePort,
  bootFakeApp,
  connectRenderer,
  mergeSettings,
  withDb as withDbFile,
  identityPrecheck,
  identityGate
} from './lib/fakeBoot.mjs'
import { startOtlpReceiver } from './lib/otlpReceiver.mjs'

const ROOT = path.join(os.tmpdir(), `argus-inc1-${process.pid}`)
const HOME = path.join(ROOT, 'home')
const FAKE_DIR = path.join(HOME, 'fake-runner')
const DB = path.join(HOME, 'argus.db')
const LOG = path.join(ROOT, 'electron.log')
const SLUG = 'live-inc1'
const TITLE = 'Offline route returns NoRoute (live inc1)'
const MODEL = process.env.GATE_MODEL || 'claude-opus-5'
const TURN_BUDGET_MS = 6 * 60 * 1000
const EXPORT_TIMEOUT_MS = 25_000
const NOTE = 'that BLOCKED_VERSION line is from the previous build'

const EVIDENCE = [
  '2026-10-26 09:14:01 Navigator start profile=driving tilesVersion=2026_06_25-03_00_00 offline=strict',
  '2026-10-26 09:14:02 TileStore open path=/data/tile_store quota=400MB',
  '2026-10-26 09:14:05 Route request origin=52.5200,13.4050 dest=52.3906,13.0645 alternatives=false',
  '2026-10-26 09:14:05 TileRegion berlin-sw download start est=96MB',
  '2026-10-26 09:14:07 TileRegionLoadError: BLOCKED_VERSION region=berlin-sw tilesVersion=2026_06_25-03_00_00 rejected by server',
  '2026-10-26 09:14:07 Route calculation failed: NoRoute (offline strict, region missing)'
].join('\n')

const TURN1 =
  'Read the evidence file evidence/run.txt with your evidence tools. Then record exactly ONE finding ' +
  'with append_finding: a short title naming why the route fails, and a body that cites the decisive ' +
  'log line as [evidence/run.txt:<line>]. Record exactly one finding, nothing else, then reply in one sentence.'
const TURN2 =
  'Continue. In one or two sentences, say what you will do about your earlier finding, then stop.'

let rx = null
installTeardown(ROOT, () => rx?.close())
const withDb = (fn) => withDbFile(DB, fn)

const findings = () =>
  withDb((db) =>
    db
      .prepare(
        `SELECT f.id, f.summary, f.review_state, f.review_actor, f.reject_tag, f.reject_note, f.session_id, f.turn_id
           FROM findings f JOIN cases c ON c.id = f.case_id WHERE c.slug = ? ORDER BY f.id`
      )
      .all(SLUG)
  )
const turnsOf = (sid) =>
  withDb((db) =>
    db.prepare(`SELECT id, status FROM turns WHERE session_id = ? ORDER BY id`).all(sid)
  )
const mirror = (sid) => {
  const f = path.join(HOME, 'cases', SLUG, 'sessions', `${sid}.jsonl`)
  if (!fs.existsSync(f)) return []
  return fs
    .readFileSync(f, 'utf8')
    .split('\n')
    .filter(Boolean)
    .map((l) => JSON.parse(l))
}

/** Score spans + their events, flattened to one attribute bag each (the sink puts the score
 *  attributes on the span event; be tolerant of either placement). */
const scoreBags = () =>
  rx
    .spans()
    .filter((s) => s.name === 'evaluation finding_accepted')
    .map((s) => ({
      ...s.attributes,
      ...Object.assign({}, ...s.events.map((e) => e.attributes))
    }))

const main = async () => {
  const t0 = Date.now()
  rx = await startOtlpReceiver({ port: 0 })
  console.error(`OTLP receiver on ${rx.url}`)
  fs.rmSync(ROOT, { recursive: true, force: true })
  fs.mkdirSync(FAKE_DIR, { recursive: true })
  const now = new Date().toISOString()
  mergeSettings(HOME, {
    agent: { defaultPermissionMode: 'bypassPermissions' },
    // Without this stamp `migrateBypassDefault` resets the mode above on the very first boot
    // (same seed as cdp-session-branch.mjs); the onboarding flags keep the first-run tour away.
    migrations: { bypassDefaultReset: now },
    onboarding: { completedAt: now, phase1Done: true, tourDone: true },
    observability: {
      providers: {
        otlp: { enabled: true, endpoint: rx.url, protocol: 'http/json', captureContent: false }
      }
    }
  })

  const PORT = await freePort(9260, 9290)
  const bootDeadline = Date.now() + BOOT_TIMEOUT_MS
  await bootFakeApp({ home: HOME, port: PORT, fakeDir: FAKE_DIR, log: LOG, deadline: bootDeadline })
  const conn = await connectRenderer(PORT, bootDeadline)
  console.error(`booted + connected in ${((Date.now() - t0) / 1000).toFixed(1)}s`)

  // ---- 0. identity + settings ----
  await identityPrecheck(conn, PORT, DB)
  await conn.evalJs(`window.argus.cases.create(${JSON.stringify({ slug: SLUG, title: TITLE })})`)
  await identityGate(conn, PORT, DB, [SLUG])
  check(
    'identity: fixture case visible on the connected app AND a row in ARGUS_HOME/argus.db',
    true
  )
  const st = (await conn.evalJs(`window.argus.settings.get()`))?.settings
  const mode = st?.agent?.defaultPermissionMode
  if (mode !== 'bypassPermissions') abort(`SETTINGS FAIL: defaultPermissionMode=${mode}`)
  if (st?.observability?.providers?.otlp?.endpoint !== rx.url)
    abort('SETTINGS FAIL: the app does not report the OTLP receiver endpoint')
  check('app reports bypassPermissions + the OTLP receiver', true)

  // ---- 1. session, model pin, evidence, open the case ----
  await conn.evalJs(`window.argus.sessions.create(${JSON.stringify(SLUG)})`)
  const sessions = await conn.evalJs(`window.argus.sessions.list(${JSON.stringify(SLUG)})`)
  const SID = sessions[0].id
  await conn.evalJs(
    `window.argus.sessions.setModel(${SID}, ${JSON.stringify(sessions[0].instanceId)}, ${JSON.stringify(MODEL)})`
  )
  await conn.evalJs(
    `window.argus.evidence.ingestContent(${JSON.stringify(SLUG)}, 'run.txt', new TextEncoder().encode(${JSON.stringify(EVIDENCE)}))`
  )
  const ev = await conn.evalJs(`window.argus.evidence.list(${JSON.stringify(SLUG)})`)
  check(
    'evidence/run.txt ingested',
    (ev ?? []).some((e) => /run\.txt$/.test(e.relPath)),
    ev?.map((e) => e.relPath)
  )

  async function openCase() {
    await conn.send('Page.reload', { ignoreCache: true })
    await sleep(3500)
    await waitFor('case list to load', () =>
      conn.evalJs(`document.querySelectorAll('[data-testid="case-title"]').length > 0`)
    )
    const clicked = await conn.evalJs(`(() => {
      const h = [...document.querySelectorAll('[data-testid="case-title"]')]
        .find((el) => el.textContent.trim() === ${JSON.stringify(TITLE)})
      if (!h) return false
      h.click()
      return true
    })()`)
    if (!clicked) throw new Error(`case card ${JSON.stringify(TITLE)} not on screen`)
    await waitFor(
      'composer to mount',
      () => conn.evalJs(`!!document.querySelector('textarea[placeholder^="Message the analyst"]')`),
      30000
    )
  }
  await openCase()

  async function sendTurn(text, label) {
    const before = new Set(turnsOf(SID).map((t) => t.id))
    await conn.evalJs(
      `window.argus.agent.send(${JSON.stringify(SLUG)}, ${SID}, ${JSON.stringify(text)})`
    )
    const t1 = Date.now()
    const row = await waitFor(
      `${label} to complete`,
      () => turnsOf(SID).find((t) => !before.has(t.id) && t.status !== 'running') ?? null,
      TURN_BUDGET_MS
    )
    console.error(
      `${label}: turn ${row.id} ${row.status} in ${Math.round((Date.now() - t1) / 1000)}s`
    )
    return row
  }

  // Page-side helpers.
  const INLINE = `document.querySelector('[data-testid="inline-finding"]')`
  const inlineText = () => conn.evalJs(`(${INLINE})?.innerText ?? null`)
  const railCardText = (summary) =>
    conn.evalJs(`(() => {
      const li = [...document.querySelectorAll('li')].find((l) =>
        !l.closest('[data-testid="inline-finding"]') && l.innerText.includes(${JSON.stringify(summary)}))
      return li ? li.innerText : null
    })()`)
  const railCardClass = (summary) =>
    conn.evalJs(`(() => {
      const li = [...document.querySelectorAll('li')].find((l) =>
        !l.closest('[data-testid="inline-finding"]') && l.innerText.includes(${JSON.stringify(summary)}))
      return li ? li.className : null
    })()`)
  const inlineHas = (sel) => conn.evalJs(`!!(${INLINE})?.querySelector(${JSON.stringify(sel)})`)
  const clickInline = (sel) =>
    conn.evalJs(
      `(() => { const b = (${INLINE})?.querySelector(${JSON.stringify(sel)}); if (!b) return false; b.click(); return true })()`
    )
  const toolRowNames = () =>
    conn.evalJs(
      `[...document.querySelectorAll('span')].map((s) => s.textContent).filter((t) => /^argus:/.test(t))`
    )

  // ---- 2. turn 1 records one finding ----
  const row1 = await sendTurn(TURN1, 'turn 1')
  if (row1.status !== 'success') {
    console.error(`TURN FAIL: turn 1 ended ${row1.status} (model ${MODEL}); see ${LOG}`)
    process.exit(2)
  }
  const f1 = findings()
  check(
    'turn 1 recorded exactly one finding',
    f1.length === 1,
    f1.map((f) => f.summary)
  )
  if (f1.length !== 1) report()
  const F = f1[0]
  check(
    'the finding is pending, no actor, no tag',
    F.review_state === 'pending' && F.review_actor === null && F.reject_tag === null
  )
  const inline = await waitFor('the inline finding card', inlineText, 20000)
  check('inline card shows the finding title', inline.includes(F.summary), inline.slice(0, 120))
  check(
    'inline card has the thumbs',
    await inlineHas('button[aria-label="Mark finding not useful"]')
  )
  const rows = await toolRowNames()
  check(
    'no argus:append_finding tool row in the transcript',
    !rows.includes('argus:append_finding'),
    rows
  )
  check('other argus tool rows still render as tool cards', rows.length > 0, rows)
  const railBefore = await railCardText(F.summary)
  check('the rail shows the same finding', railBefore !== null)

  // ---- 3. thumbs-down on the inline card ----
  check(
    'clicked thumbs-down on the inline card',
    await clickInline('button[aria-label="Mark finding not useful"]')
  )
  const rejected = await waitFor(
    'DB rejected by human',
    () => {
      const f = findings()[0]
      return f.review_state === 'rejected' && f.review_actor === 'human' ? f : null
    },
    15000
  )
  check(
    'DB: rejected, actor human, no tag yet',
    rejected.reject_tag === null && rejected.reject_note === null,
    rejected
  )
  check(
    'reason strip open under the inline card',
    await waitFor('strip', () => inlineHas('button[aria-label="Reject as wrong"]'), 10000)
  )
  const railCls = await railCardClass(F.summary)
  check('rail card turned red too (shared store)', /border-danger/.test(railCls ?? ''), railCls)

  // ---- 4. label it Wrong with a note ----
  await conn.evalJs(`(() => {
    const el = (${INLINE}).querySelector('input[aria-label="Reject note"]')
    const set = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set
    set.call(el, ${JSON.stringify(NOTE)})
    el.dispatchEvent(new Event('input', { bubbles: true }))
    return true
  })()`)
  check('clicked Reject as wrong', await clickInline('button[aria-label="Reject as wrong"]'))
  const tagged = await waitFor(
    'DB tag=wrong + note',
    () => {
      const f = findings()[0]
      return f.reject_tag === 'wrong' && f.reject_note === NOTE ? f : null
    },
    15000
  )
  check(
    'DB: reject_tag=wrong, note stored, still rejected/human',
    tagged.review_state === 'rejected' && tagged.review_actor === 'human',
    tagged
  )
  await waitFor(
    'strip closed',
    async () => !(await inlineHas('button[aria-label="Reject as wrong"]')),
    10000
  )
  check('strip closed after the pick', true)
  const inlineAfter = await inlineText()
  check(
    'inline card shows Wrong + the note',
    inlineAfter.includes('Wrong') && inlineAfter.includes(NOTE),
    inlineAfter.slice(-160)
  )
  const railAfter = await railCardText(F.summary)
  check(
    'rail card shows Wrong + the note',
    (railAfter ?? '').includes('Wrong') && (railAfter ?? '').includes(NOTE),
    railAfter
  )

  // ---- 5. turn 2: the agent hears the review; the transcript stays raw ----
  const row2 = await sendTurn(TURN2, 'turn 2')
  check('turn 2 succeeded', row2.status === 'success', row2.status)
  const ms = mirror(SID)
  const started2 = ms.find((e) => e.type === 'turn.started' && e.turnId === row2.id)
  check(
    'mirror turn.started carries the RAW user text (delta is driver-only)',
    started2?.payload?.userText === TURN2,
    started2?.payload?.userText
  )
  const bubble = await conn.evalJs(
    `[...document.querySelectorAll('[data-turn-id="${row2.id}"]')].map((e) => e.innerText).join('\\n')`
  )
  check('transcript user bubble is the raw text', bubble.trim() === TURN2, bubble)
  const reply = ms
    .filter((e) => e.type === 'assistant.message' && e.turnId === row2.id)
    .map((e) => e.payload.text)
    .join('\n')
  check(
    'reply acknowledges the rejection',
    /reject|withdraw|retract|rule[d]? out|not record|drop|wrong|previous build|old build/i.test(
      reply
    ),
    reply.slice(0, 300)
  )
  const f2 = findings()
  check(
    'the rejected finding was not re-recorded under the same title',
    f2.filter((f) => f.summary === F.summary).length === 1,
    f2.map((f) => `${f.id}:${f.review_state}:${f.summary}`)
  )
  check(
    'the human reject survived turn 2 (agent cannot overturn it)',
    f2[0].review_state === 'rejected' &&
      f2[0].review_actor === 'human' &&
      f2[0].reject_tag === 'wrong'
  )

  // ---- 6. tool cards hidden + reload: the card hydrates from the persisted tool result ----
  await conn.evalJs(`localStorage.setItem('argus.ui.showToolCalls', 'false'); 1`)
  await openCase()
  const hiddenInline = await waitFor(
    'inline card after reload with tool cards hidden',
    inlineText,
    20000
  )
  check(
    'finding card still rendered with tool cards hidden (hydrated)',
    hiddenInline.includes(F.summary) && hiddenInline.includes('Wrong')
  )
  const rowsHidden = await toolRowNames()
  check('no tool rows at all while hidden', rowsHidden.length === 0, rowsHidden)
  await conn.evalJs(`localStorage.setItem('argus.ui.showToolCalls', 'true'); 1`)

  // ---- 7. score read-back: one upserted id, labelled ----
  const bags = await waitFor(
    'finding_accepted spans at the receiver',
    () => {
      const b = scoreBags()
      return b.length >= 2 ? b : null
    },
    EXPORT_TIMEOUT_MS
  ).catch(() => scoreBags())
  const ids = new Set(bags.map((b) => b['argus.score.id']))
  check(
    '≥2 finding_accepted scores reached the receiver (reject, then label)',
    bags.length >= 2,
    bags.length
  )
  check(
    'all of them share ONE argus.score.id (upsert id)',
    ids.size === 1 && [...ids][0]?.length === 32,
    [...ids]
  )
  const last = bags[bags.length - 1] ?? {}
  check(
    'latest score: value 0, actor human, tag wrong',
    last['gen_ai.evaluation.score.value'] === 0 && last.actor === 'human' && last.tag === 'wrong',
    {
      value: last['gen_ai.evaluation.score.value'],
      actor: last.actor,
      tag: last.tag,
      findingId: last.findingId
    }
  )
  check('no note on the wire (captureContent off)', !('gen_ai.evaluation.explanation' in last))

  const cost = withDb(
    (db) =>
      db.prepare(`SELECT COALESCE(SUM(cost_usd),0) AS c FROM turns WHERE session_id = ?`).get(SID).c
  )
  console.error(`spend: $${Number(cost).toFixed(3)} over 2 turns (${MODEL}); log ${LOG}`)
  report()
}

main().catch((err) => {
  console.error(err)
  process.exit(1)
})
