#!/usr/bin/env node
/**
 * Findings increment 2 live exit-check (plan 2026-10-26-findings-inc2-causal-chain.md, Task 12
 * step 3) — drives the REAL app over CDP against a scratch ARGUS_HOME with a REAL Claude chat
 * session (three short investigation turns, then one short review-session turn), and the
 * headless runners replaced by the fake (never reached: no distill here).
 *
 * Flow (self-boot; helpers in scripts/lib/fakeBoot.mjs):
 *   0. scratch home whose settings pin bypassPermissions (+ the migration stamp that keeps it,
 *      + the onboarding flags); boot on a free CDP port in 9260-9290; identity gate (exit 2 on a
 *      mismatch — argus-cdp-port-collision).
 *   1. case + a session pinned to GATE_MODEL, one invented evidence file, open the case.
 *   2. turn 1: a confirmed symptom caused_by a hypothesis (role contributing). DB shape; the rail
 *      shows both under UNEXPLAINED, the symptom indented under the dashed hypothesis.
 *   3. turn 2: a sharper confirmed root cause supersedes the hypothesis, then update_finding
 *      appends evidence. DB: hypothesis retracted by the agent with `superseded by #N`, the
 *      symptom re-parented, findings.md has the `### Update` section; transcript: the update is
 *      an inline card, not a tool row; rail: ROOT CAUSE tree, RULED OUT · 1 collapsed.
 *   4. human role edit on the symptom's rail card → DB role_source human, chip `set by human`.
 *   5. turn 3 ("Continue."): raw text in the mirror and the bubble; the reply mentions the role
 *      the human set; the agent did not overwrite it.
 *   6. list_findings output (mirror tool results): the tree shape.
 *   7. the Review walk on a deliberately short rail (a long list in miniature): `s` scrolls the
 *      next card into view; `k` back, `a` accepts in the DB as human and advances; Escape ends.
 *   8. review-session guard: link a scratch git repo, switch the case to review mode, one real
 *      turn asks for append_finding with role root-cause → the tool refuses with the review-mode
 *      text, and no chain field is written anywhere.
 *
 * Every string here (case, evidence, prompts) is invented.
 *
 * Usage:  cd app && GATE_MODEL=claude-opus-5 node scripts/cdp-findings-inc2.mjs
 * Exits 0 when every check passes, 1 when any fails, 2 on an abort.
 */
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { execFileSync } from 'node:child_process'
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

const ROOT = path.join(os.tmpdir(), `argus-inc2-${process.pid}`)
const HOME = path.join(ROOT, 'home')
const FAKE_DIR = path.join(HOME, 'fake-runner')
const REPO = path.join(ROOT, 'repo')
const DB = path.join(HOME, 'argus.db')
const LOG = path.join(ROOT, 'electron.log')
const SLUG = 'live-inc2'
const TITLE = 'Album export fails with a write error (live inc2)'
const MODEL = process.env.GATE_MODEL || 'claude-opus-5'
const TURN_BUDGET_MS = 6 * 60 * 1000

const EVIDENCE = [
  '2026-10-27 08:00:00 exportd start version=3.2.0 scratch=/var/scratch quota=2GB',
  '2026-10-27 08:00:00 config cache.gc=false (default changed in 3.2.0; was true)',
  '2026-10-27 08:00:01 cache-gc skipped: disabled by config',
  '2026-10-27 09:41:17 scratch usage 1.98GB/2GB (99%)',
  '2026-10-27 09:41:18 export job=41 album=harbour-walk write /var/scratch/job41.zip failed: ENOSPC',
  '2026-10-27 09:41:18 export job=41 FAILED: write error (user sees "Export failed, try again")'
].join('\n')

const TURN1 =
  'Read evidence/run.txt. Record the symptom as a confirmed finding with role symptom. Then record ' +
  'your best explanation of its cause as a SEPARATE finding with status hypothesis and role ' +
  'contributing, and link the symptom to it with caused_by. Do not record anything else.'
const turn2 = (hypId) =>
  'The evidence confirms your hypothesis but the mechanism is sharper than you wrote: record the ' +
  'sharper explanation as a NEW confirmed finding with role root-cause that supersedes your ' +
  `hypothesis (supersedes: ${hypId}), then append one line of evidence citing the log to the new ` +
  'finding with update_finding.'
const TURN3 = 'Continue.'
const REVIEW_TURN =
  'Call append_finding exactly once with summary "Gate probe finding", body "probe", status ' +
  'confirmed and role root-cause. If the tool refuses, do not retry: reply with its message and stop.'
const REVIEW_REFUSAL = 'apply to investigation findings; this is a review session'

installTeardown(ROOT)
const withDb = (fn) => withDbFile(DB, fn)

const findings = () =>
  withDb((db) =>
    db
      .prepare(
        `SELECT f.id, f.summary, f.session_id, f.status, f.role, f.role_source, f.caused_by,
                f.superseded_by, f.review_state, f.review_actor, f.review_reason
           FROM findings f JOIN cases c ON c.id = f.case_id WHERE c.slug = ? ORDER BY f.id`
      )
      .all(SLUG)
  )
const byId = (id) => findings().find((f) => f.id === id) ?? null
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
const toolResults = (sid, re) =>
  mirror(sid).filter((e) => e.type === 'tool.call.completed' && re.test(e.payload?.name ?? ''))
/** findings.md split into `<!-- finding:N -->` blocks. */
const findingBlock = (id) => {
  const md = fs.readFileSync(path.join(HOME, 'cases', SLUG, 'findings.md'), 'utf8')
  const parts = md.split(/<!-- finding:(\d+) -->/)
  for (let i = 1; i < parts.length; i += 2) if (Number(parts[i]) === id) return parts[i + 1]
  return null
}

const main = async () => {
  const t0 = Date.now()
  fs.rmSync(ROOT, { recursive: true, force: true })
  fs.mkdirSync(FAKE_DIR, { recursive: true })
  const now = new Date().toISOString()
  mergeSettings(HOME, {
    agent: { defaultPermissionMode: 'bypassPermissions' },
    // Without this stamp `migrateBypassDefault` resets the mode above on the very first boot;
    // the onboarding flags keep the first-run tour away (argus-cdp-gate-seed-and-turn-status).
    migrations: { bypassDefaultReset: now },
    onboarding: { completedAt: now, phase1Done: true, tourDone: true }
  })
  // A scratch git repo, linked at step 8 so the case can enter review mode.
  fs.mkdirSync(REPO, { recursive: true })
  fs.writeFileSync(path.join(REPO, 'README.md'), '# gate repo\n')
  const git = (...args) => execFileSync('git', args, { cwd: REPO, stdio: 'ignore' })
  git('init', '-q', '-b', 'main')
  git('add', '.')
  git('-c', 'user.name=gate', '-c', 'user.email=gate@example.invalid', 'commit', '-q', '-m', 'init')

  const PORT = await freePort(9260, 9290)
  const bootDeadline = Date.now() + BOOT_TIMEOUT_MS
  await bootFakeApp({ home: HOME, port: PORT, fakeDir: FAKE_DIR, log: LOG, deadline: bootDeadline })
  const conn = await connectRenderer(PORT, bootDeadline)
  console.error(`booted + connected in ${((Date.now() - t0) / 1000).toFixed(1)}s`)

  // ---- 0. identity + settings (both abort on a mismatch, so these checks record a pass) ----
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
  check('app reports bypassPermissions', mode === 'bypassPermissions')

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

  async function sendTurn(sid, text, label) {
    const before = new Set(turnsOf(sid).map((t) => t.id))
    await conn.evalJs(
      `window.argus.agent.send(${JSON.stringify(SLUG)}, ${sid}, ${JSON.stringify(text)})`
    )
    const t1 = Date.now()
    const row = await waitFor(
      `${label} to complete`,
      () => turnsOf(sid).find((t) => !before.has(t.id) && t.status !== 'running') ?? null,
      TURN_BUDGET_MS
    )
    console.error(
      `${label}: turn ${row.id} ${row.status} in ${Math.round((Date.now() - t1) / 1000)}s`
    )
    return row
  }
  const mustSucceed = (row, label) => {
    if (row.status === 'success') return
    console.error(`TURN FAIL: ${label} ended ${row.status} (model ${MODEL}); see ${LOG}`)
    process.exit(2)
  }

  // ---- page-side readers. Rail cards are `li[data-finding-id]` outside the inline chat cards. ----
  /** One section's cards in DOM order: id, marginLeft, data-status, chip, role chip title. */
  const railSection = (label) =>
    conn.evalJs(`(() => {
      const ul = document.querySelector('ul[aria-label=${JSON.stringify(label)}]')
      if (!ul) return null
      return [...ul.querySelectorAll(':scope > li[data-finding-id]')].map((li) => ({
        id: Number(li.dataset.findingId),
        marginLeft: li.style.marginLeft,
        status: li.dataset.status ?? null,
        chip: !!li.querySelector('[data-testid="status-chip"]'),
        roleTitle: [...li.querySelectorAll('span[title^="set by "]')].map((s) => s.title)[0] ?? null
      }))
    })()`)
  const railHeader = () =>
    conn.evalJs(`(() => {
      const el = [...document.querySelectorAll('div')].find((e) =>
        e.children.length === 0 && e.textContent.trim().startsWith('Findings · '))
      return el ? el.textContent.trim() : null
    })()`)
  const ruledOutButton = () =>
    conn.evalJs(`(() => {
      const b = [...document.querySelectorAll('button[aria-expanded]')].find((x) =>
        x.textContent.trim().startsWith('RULED OUT'))
      return b ? { text: b.textContent.trim(), expanded: b.getAttribute('aria-expanded') } : null
    })()`)
  const toolRowNames = () =>
    conn.evalJs(
      `[...document.querySelectorAll('span')].map((s) => s.textContent).filter((t) => /^argus:/.test(t))`
    )
  const inlineCardIds = () =>
    conn.evalJs(
      `[...document.querySelectorAll('[data-testid="inline-finding"] li[data-finding-id]')].map((li) => Number(li.dataset.findingId))`
    )
  const railLi = (id) =>
    `[...document.querySelectorAll('li[data-finding-id="${id}"]')].find((li) => !li.closest('[data-testid="inline-finding"]'))`

  // ---- 2. turn 1: a confirmed symptom caused by a hypothesis ----
  const row1 = await sendTurn(SID, TURN1, 'turn 1')
  mustSucceed(row1, 'turn 1')
  const f1 = findings()
  check(
    'turn 1 recorded exactly two findings',
    f1.length === 2,
    f1.map((f) => `${f.id}:${f.status}:${f.role}:${f.caused_by}:${f.summary}`)
  )
  const SYM = f1.find((f) => f.role === 'symptom')
  const HYP = f1.find((f) => f.status === 'hypothesis')
  check(
    'symptom: confirmed, role symptom, caused_by the hypothesis',
    SYM && HYP && SYM.status === 'confirmed' && SYM.caused_by === HYP.id,
    SYM
  )
  check(
    'hypothesis: status hypothesis, role contributing, role_source agent',
    HYP && HYP.role === 'contributing' && HYP.role_source === 'agent',
    HYP
  )
  if (!SYM || !HYP) report()

  // ---- 2b. the rail: UNEXPLAINED, the symptom indented under the dashed hypothesis ----
  const unexplained1 = await waitFor(
    'UNEXPLAINED with both cards',
    async () => {
      const s = await railSection('UNEXPLAINED')
      return s && s.length === 2 ? s : null
    },
    20000
  ).catch(() => railSection('UNEXPLAINED'))
  const hypCard = unexplained1?.[0]
  const symCard = unexplained1?.[1]
  check(
    'rail: UNEXPLAINED lists the hypothesis first, the symptom under it at 14px',
    hypCard?.id === HYP.id &&
      hypCard.marginLeft === '' &&
      symCard?.id === SYM.id &&
      symCard.marginLeft === '14px',
    unexplained1
  )
  check(
    'rail: the hypothesis card is data-status=hypothesis with the status chip',
    hypCard?.status === 'hypothesis' && hypCard.chip && symCard?.chip === false,
    hypCard
  )
  check('rail: no ROOT CAUSE list yet', (await railSection('ROOT CAUSE')) === null)
  const header1 = await railHeader()
  check(
    'rail header: Findings · 2 · 2 to review',
    header1 === 'Findings · 2 · 2 to review',
    header1
  )

  // ---- 3. turn 2: supersede with a sharper root cause, then update_finding ----
  const row2 = await sendTurn(SID, turn2(HYP.id), 'turn 2')
  mustSucceed(row2, 'turn 2')
  const f2 = findings()
  const NEW = f2.find((f) => f.id > SYM.id && f.id !== HYP.id && f.role === 'root-cause')
  check(
    'turn 2: a new confirmed root cause, role_source agent',
    NEW && NEW.status === 'confirmed' && NEW.role_source === 'agent',
    f2.map((f) => `${f.id}:${f.status}:${f.role}:${f.role_source}:${f.summary}`)
  )
  if (!NEW) report()
  const hyp2 = byId(HYP.id)
  check(
    'the hypothesis was retracted by the agent as superseded by the new finding',
    hyp2.review_state === 'rejected' &&
      hyp2.review_actor === 'agent' &&
      hyp2.review_reason === `superseded by #${NEW.id}` &&
      hyp2.superseded_by === NEW.id,
    hyp2
  )
  check(
    "the symptom's caused_by was re-parented to the new root cause",
    byId(SYM.id).caused_by === NEW.id,
    byId(SYM.id)
  )
  const block = findingBlock(NEW.id)
  check(
    "findings.md: a ### Update section inside the new finding's block",
    /### Update /.test(block ?? ''),
    (block ?? '').slice(-240)
  )
  const updates = toolResults(SID, /update_finding$/).filter((e) => e.turnId === row2.id)
  check(
    'update_finding ran in turn 2 and succeeded',
    updates.some((e) => !e.payload.isError && /updated/.test(e.payload.outputPreview)),
    updates.map((e) => e.payload.outputPreview.slice(0, 120))
  )
  const inline2 = await waitFor(
    'two inline cards for the new finding (append + update)',
    async () => {
      const ids = await inlineCardIds()
      return ids.filter((i) => i === NEW.id).length >= 2 ? ids : null
    },
    20000
  ).catch(() => inlineCardIds())
  check(
    'transcript: the update renders as an inline finding card (append + update cards)',
    inline2.filter((i) => i === NEW.id).length >= 2,
    inline2
  )
  const rows2 = await toolRowNames()
  check(
    'transcript: no argus:update_finding (or append_finding) tool row',
    !rows2.includes('argus:update_finding') && !rows2.includes('argus:append_finding'),
    rows2
  )
  const root2 = await waitFor(
    'ROOT CAUSE tree',
    async () => {
      const s = await railSection('ROOT CAUSE')
      return s && s.length >= 2 ? s : null
    },
    20000
  ).catch(() => railSection('ROOT CAUSE'))
  check(
    'rail: ROOT CAUSE with the new root at depth 0 and the symptom at 14px',
    root2?.[0]?.id === NEW.id &&
      root2[0].marginLeft === '' &&
      root2.some((c) => c.id === SYM.id && c.marginLeft === '14px'),
    root2
  )
  check('rail: no UNEXPLAINED list', (await railSection('UNEXPLAINED')) === null)
  const ro2 = await ruledOutButton()
  check(
    'rail: RULED OUT · 1, collapsed',
    ro2?.text === 'RULED OUT · 1' && ro2.expanded === 'false',
    ro2
  )
  const header2 = await railHeader()
  check(
    'rail header: Findings · 3 · 2 to review',
    header2 === 'Findings · 3 · 2 to review',
    header2
  )

  // ---- 4. the human sets the symptom's role on its rail card ----
  const opened = await conn.evalJs(`(() => {
    const li = ${railLi(SYM.id)}
    const b = li && li.querySelector('button[aria-expanded]')
    if (!b) return false
    if (b.getAttribute('aria-expanded') !== 'true') b.click()
    return true
  })()`)
  check('opened the symptom card in the rail', opened)
  await waitFor(
    'the Role select on the open card',
    () => conn.evalJs(`!!(${railLi(SYM.id)})?.querySelector('select[aria-label="Role"]')`),
    10000
  )
  await conn.evalJs(`(() => {
    const el = (${railLi(SYM.id)}).querySelector('select[aria-label="Role"]')
    const set = Object.getOwnPropertyDescriptor(HTMLSelectElement.prototype, 'value').set
    set.call(el, 'contributing')
    el.dispatchEvent(new Event('change', { bubbles: true }))
    return true
  })()`)
  const edited = await waitFor(
    'DB role contributing / human',
    () => {
      const f = byId(SYM.id)
      return f.role === 'contributing' && f.role_source === 'human' ? f : null
    },
    15000
  ).catch(() => byId(SYM.id))
  check(
    'DB: role contributing, role_source human',
    edited.role === 'contributing' && edited.role_source === 'human',
    edited
  )
  const chipTitle = await waitFor(
    'the role chip says set by human',
    () =>
      conn.evalJs(
        `(${railLi(SYM.id)})?.querySelector('span[title="set by human"]')?.title ?? null`
      ),
    10000
  ).catch(() => null)
  check('rail: the role chip title is "set by human"', chipTitle === 'set by human', chipTitle)

  // ---- 5. turn 3: the agent hears the edit; the transcript stays raw ----
  const row3 = await sendTurn(SID, TURN3, 'turn 3')
  check('turn 3 succeeded', row3.status === 'success', row3.status)
  const ms = mirror(SID)
  const started3 = ms.find((e) => e.type === 'turn.started' && e.turnId === row3.id)
  check(
    'mirror turn.started carries only "Continue." (the edit line is driver-only)',
    started3?.payload?.userText === TURN3,
    started3?.payload?.userText
  )
  const bubble = await conn.evalJs(
    `[...document.querySelectorAll('[data-turn-id="${row3.id}"]')].map((e) => e.innerText).join('\\n')`
  )
  check('transcript user bubble is only "Continue."', bubble.trim() === TURN3, bubble)
  const reply3 = ms
    .filter((e) => e.type === 'assistant.message' && e.turnId === row3.id)
    .map((e) => e.payload.text)
    .join('\n')
  check(
    'the reply mentions the role the human set (contributing)',
    /contributing/i.test(reply3),
    reply3.slice(0, 300)
  )
  const sym3 = byId(SYM.id)
  check(
    'the human role survived turn 3 (role contributing, role_source human)',
    sym3.role === 'contributing' && sym3.role_source === 'human',
    sym3
  )

  // ---- 6. list_findings shows the tree ----
  // Turns 2–3 only (turn 1 lists an empty case). Before the supersede the tree has no root, so
  // it opens with UNEXPLAINED; a call in turn 3 must open with ROOT CAUSE.
  const lists = toolResults(SID, /list_findings$/).filter(
    (e) => e.turnId === row2.id || e.turnId === row3.id
  )
  if (lists.length === 0) {
    console.error('SKIP  list_findings shape — the agent did not call list_findings in turns 2–3')
  } else {
    const shapes = lists.map((e) => ({
      turn: e.turnId === row3.id ? 3 : 2,
      head: e.payload.outputPreview.slice(0, 60)
    }))
    check(
      'list_findings renders the tree (turn 3 opens with ROOT CAUSE)',
      shapes.every(
        (s) =>
          s.head.startsWith('ROOT CAUSE (') || (s.turn === 2 && s.head.startsWith('UNEXPLAINED ('))
      ),
      shapes
    )
  }

  // ---- 7. the Review walk ----
  // Collapse whatever card is open so the walk starts from the plain rail.
  await conn.evalJs(`(() => {
    const li = ${railLi(SYM.id)}
    const b = li && li.querySelector('button[aria-expanded="true"]')
    if (b) b.click()
    return true
  })()`)
  const pendingNow = new Set(
    findings()
      .filter((f) => f.review_state === 'pending')
      .map((f) => f.id)
  )
  const treeOrder = [
    ...((await railSection('ROOT CAUSE')) ?? []),
    ...((await railSection('UNEXPLAINED')) ?? [])
  ].map((c) => c.id)
  const walkIds = treeOrder.filter((id) => pendingNow.has(id))
  const n = walkIds.length
  check('at least two pending cards to walk', n >= 2, { treeOrder, walkIds })
  const clickedReview = await conn.evalJs(`(() => {
    const b = document.querySelector('button[aria-label="Review pending findings"]')
    if (!b) return false
    b.click()
    return true
  })()`)
  check('clicked Review pending findings', clickedReview)
  const barText = () =>
    conn.evalJs(
      `document.querySelector('[data-testid="review-walk"]')?.textContent.split('·')[0].trim() ?? null`
    )
  const bar1 = await waitFor('the walk bar', barText, 10000).catch(() => null)
  check(`walk bar: Reviewing 1 of ${n}`, bar1 === `Reviewing 1 of ${n}`, bar1)
  const focused = await conn.evalJs(
    `document.activeElement?.tabIndex === -1 && !!document.activeElement.querySelector('li[data-finding-id="${walkIds[0]}"]')`
  )
  check('the walk focused the rail list', focused)
  const press = (key) =>
    conn.evalJs(
      `document.activeElement.dispatchEvent(new KeyboardEvent('keydown', { key: ${JSON.stringify(key)}, bubbles: true, cancelable: true }))`
    )

  // A long list in miniature: cap the rail's scroll box so the next card starts below the fold.
  // (Shrinking the box can leave it slightly scrolled by scroll anchoring, so the precondition
  // is "below the fold" and the check compares scrollTop before and after `s`.)
  const geometry = (id) =>
    conn.evalJs(`(() => {
      const box = document.activeElement
      const li = box.querySelector('li[data-finding-id="${id}"]')
      if (!li) return null
      const b = box.getBoundingClientRect(), c = li.getBoundingClientRect()
      return { boxTop: b.top, boxBottom: b.bottom, cardTop: c.top, scrollTop: box.scrollTop }
    })()`)
  await conn.evalJs(`(() => { document.activeElement.style.maxHeight = '80px'; return true })()`)
  await sleep(300)
  const g0 = await geometry(walkIds[1])
  check(
    'precondition: the second walk card starts below the rail fold',
    g0 && g0.cardTop >= g0.boxBottom,
    g0
  )
  await press('s')
  const bar2 = await waitFor(
    'bar at 2',
    async () => ((await barText()) === `Reviewing 2 of ${n}` ? `Reviewing 2 of ${n}` : null),
    5000
  ).catch(() => barText())
  check(`s: Reviewing 2 of ${n}`, bar2 === `Reviewing 2 of ${n}`, bar2)
  await sleep(500)
  const g1 = await geometry(walkIds[1])
  check(
    "s scrolled the walk's current card into the rail's viewport",
    g0 &&
      g1 &&
      g1.scrollTop > g0.scrollTop &&
      g1.cardTop >= g1.boxTop - 1 &&
      g1.cardTop < g1.boxBottom,
    { before: g0, after: g1 }
  )
  await conn.evalJs(`(() => { document.activeElement.style.maxHeight = ''; return true })()`)
  await press('k')
  const backTo1 = await waitFor(
    'bar back at 1',
    async () => ((await barText()) === `Reviewing 1 of ${n}` ? true : null),
    5000
  ).catch(() => false)
  check('k: back to the first card', backTo1)
  await press('a')
  const accepted = await waitFor(
    'DB accepted by human',
    () => {
      const f = byId(walkIds[0])
      return f.review_state === 'accepted' && f.review_actor === 'human' ? f : null
    },
    15000
  ).catch(() => byId(walkIds[0]))
  check(
    `a: finding #${walkIds[0]} accepted by the human in the DB`,
    accepted.review_state === 'accepted' && accepted.review_actor === 'human',
    accepted
  )
  const bar3 = await waitFor(
    'bar advanced after a',
    async () => ((await barText()) === `Reviewing 2 of ${n}` ? `Reviewing 2 of ${n}` : null),
    10000
  ).catch(() => barText())
  check(`a advanced the walk to 2 of ${n}`, bar3 === `Reviewing 2 of ${n}`, bar3)
  await press('Escape')
  const gone = await waitFor(
    'bar gone',
    async () =>
      (await conn.evalJs(`!document.querySelector('[data-testid="review-walk"]')`)) || null,
    5000
  ).catch(() => false)
  check('Escape ended the walk', gone)

  // ---- 8. review-session guard ----
  const chainBefore = JSON.stringify(findings())
  const linked = await conn.evalJs(
    `window.argus.workspaces.link(${JSON.stringify(SLUG)}, ${JSON.stringify(REPO)}).then(() => true)`
  )
  check('linked the scratch repo (review mode becomes available)', linked)
  const { sessionId: RSID } = await conn.evalJs(
    `window.argus.cases.setMode(${JSON.stringify(SLUG)}, 'review')`
  )
  const rs = (await conn.evalJs(`window.argus.sessions.list(${JSON.stringify(SLUG)})`)).find(
    (s) => s.id === RSID
  )
  check('a review-mode session exists on the case', rs?.mode === 'review' && RSID !== SID, rs)
  await conn.evalJs(
    `window.argus.sessions.setModel(${RSID}, ${JSON.stringify(rs.instanceId)}, ${JSON.stringify(MODEL)})`
  )
  const rrow = await sendTurn(RSID, REVIEW_TURN, 'review turn')
  check('review turn succeeded', rrow.status === 'success', rrow.status)
  // The observable that proves the guard fired: the first append_finding (the one carrying
  // role root-cause) came back with the review-mode refusal.
  const appends = toolResults(RSID, /append_finding$/)
  check(
    'review session: append_finding with role root-cause was refused with the review-mode text',
    appends.length > 0 && appends[0].payload.outputPreview.includes(REVIEW_REFUSAL),
    appends.map((e) => ({ isError: e.payload.isError, out: e.payload.outputPreview.slice(0, 200) }))
  )
  const after = findings()
  const reviewRows = after.filter((f) => f.session_id === RSID)
  check(
    'review session: no chain field on any review row (a plain retry is allowed)',
    reviewRows.every(
      (f) =>
        f.role === null &&
        f.role_source === null &&
        f.caused_by === null &&
        f.superseded_by === null &&
        f.status !== 'hypothesis'
    ),
    reviewRows
  )
  check(
    'review session: every investigation row is unchanged',
    JSON.stringify(after.filter((f) => f.session_id !== RSID)) === chainBefore,
    after.filter((f) => f.session_id !== RSID)
  )

  const cost = withDb(
    (db) =>
      db
        .prepare(`SELECT COALESCE(SUM(cost_usd),0) AS c FROM turns WHERE session_id IN (?, ?)`)
        .get(SID, RSID).c
  )
  console.error(`spend: $${Number(cost).toFixed(3)} over 4 turns (${MODEL}); log ${LOG}`)
  report()
}

main().catch((err) => {
  console.error(err)
  process.exit(1)
})
