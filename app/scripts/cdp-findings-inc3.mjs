#!/usr/bin/env node
/**
 * Findings increment 3 live exit-check (plan 2026-10-27-findings-inc3-chain-consumers.md, Task 14
 * step 4) — drives the REAL app over CDP against a scratch ARGUS_HOME with a REAL Claude chat
 * session (three short investigation turns), and the headless runners replaced by the fake: the
 * distill job fails on its missing v3 fixtures (only its input snapshot is read), and the RCA
 * drafter answers a canned draft from `${FAKE_DIR}/live-inc3.json`.
 *
 * Flow (self-boot; helpers in scripts/lib/fakeBoot.mjs):
 *   0. scratch home whose settings pin bypassPermissions (+ the migration stamp that keeps it,
 *      + the onboarding flags); boot on a free CDP port in 9260-9290; identity gate (exit 2 on a
 *      mismatch — argus-cdp-port-collision).
 *   1. turn 1: a confirmed symptom caused_by a hypothesis (role contributing).
 *   2. turn 2: a sharper confirmed root cause supersedes the hypothesis, then update_finding
 *      replace_markdown rewrites its citation: DB re-parenting, findings.md replaced (no
 *      `### Update`), exactly three markers.
 *   3. the human accepts the root cause (IPC from the renderer).
 *   4. the Findings tab: the document's ROOT CAUSE tree with bodies open, RULED OUT · 1
 *      collapsed, header `Findings · 3 · 1 to review`.
 *   5. the Review walk inside the document: `a` accepts the symptom as the human; the walk ends.
 *   6. Correct on the root card: back on Chat, the composer holds `Finding #N: ` and is focused.
 *   7. distill projection: the redistill job's input snapshot folds the superseded hypothesis
 *      (empty body) and carries the root's status/role/roleSource and the symptom's cause.
 *   8. RCA anchoring: a canned draft with an unanchored root → the status payload's counters
 *      and the panel line `1 statement without a finding · 2 findings not used`.
 *   9. turn 3 ("Continue."): the reply names the root cause; both human accepts survive.
 *
 * Every string here (case, evidence, prompts, fixture) is invented.
 *
 * Usage:  cd app && GATE_MODEL=claude-opus-5 node scripts/cdp-findings-inc3.mjs
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
  settle,
  withDb as withDbFile,
  identityPrecheck,
  identityGate
} from './lib/fakeBoot.mjs'

const ROOT = path.join(os.tmpdir(), `argus-inc3-${process.pid}`)
const HOME = path.join(ROOT, 'home')
const FAKE_DIR = path.join(HOME, 'fake-runner')
const DB = path.join(HOME, 'argus.db')
const LOG = path.join(ROOT, 'electron.log')
const SLUG = 'live-inc3'
const TITLE = 'Thumbnail cache serves stale images after a locale switch (live inc3)'
const MODEL = process.env.GATE_MODEL || 'claude-opus-5'
const TURN_BUDGET_MS = 6 * 60 * 1000

const EVIDENCE = [
  '2026-10-27 10:00:00 thumbd start version=4.1.0 cache=/var/cache/thumbs locale=en-GB',
  '2026-10-27 10:00:00 thumb cache key = sha1(asset_id + size); locale dropped from the key in 4.1.0 (was sha1(asset_id + size + locale))',
  '2026-10-27 10:12:40 settings: user switched locale en-GB -> de-DE',
  '2026-10-27 10:12:41 thumb asset=88 size=256 cache HIT (entry rendered at 10:01:05 with locale=en-GB caption overlay)',
  '2026-10-27 10:12:41 gallery: thumbnails still show English caption overlays after the switch to de-DE'
].join('\n')

const TURN1 =
  'Read evidence/run.txt. Record the symptom as a confirmed finding with role symptom. Then record ' +
  'your best explanation of its cause as a SEPARATE finding with status hypothesis and role ' +
  'contributing, and link the symptom to it with caused_by. Do not record anything else.'
const turn2 = (hypId) =>
  'The evidence confirms your hypothesis but the mechanism is sharper than you wrote: record the ' +
  'sharper explanation as a NEW confirmed finding with role root-cause that supersedes your ' +
  `hypothesis (supersedes: ${hypId}). Then call update_finding on it with replace_markdown, ` +
  'passing the same body with the citation written as [evidence/run.txt:2].'
const TURN3 = 'Continue.'

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
const findingsMd = () => fs.readFileSync(path.join(HOME, 'cases', SLUG, 'findings.md'), 'utf8')
/** findings.md split into `<!-- finding:N -->` blocks. */
const findingBlock = (id) => {
  const parts = findingsMd().split(/<!-- finding:(\d+) -->/)
  for (let i = 1; i < parts.length; i += 2) if (Number(parts[i]) === id) return parts[i + 1]
  return null
}
/** A three-word plain-text run from a finding's body that its summary does not contain — what
 *  only a rendered body (not the card's header) puts in the card's text. */
const bodyPhrase = (id, summary) => {
  const block = findingBlock(id) ?? ''
  const lines = block
    .split('\n')
    .map((l) => l.trim())
    .filter((l) => l && !l.startsWith('#') && !/^_.*_$/.test(l) && !l.startsWith('<!--'))
  for (const line of lines) {
    const plain = line
      .replace(/`[^`]*`/g, ' ')
      .replace(/\[[^\]]*\]\([^)]*\)/g, ' ')
      .replace(/\[[^\]]*\]/g, ' ')
      .replace(/[*_]/g, '')
    for (const m of plain.matchAll(/[A-Za-z]{2,}(?: [A-Za-z]{2,}){2}/g))
      if (!summary.toLowerCase().includes(m[0].toLowerCase())) return m[0]
  }
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

  // The canned RCA draft: an unanchored root and no other claim, with a body for every enabled
  // narrative section of the live template (the parser refuses a draft missing one).
  const template = st?.rca?.template
  const sectionIds = [...(template?.exec ?? []), ...(template?.tech ?? [])]
    .filter((s) => s.enabled && s.kind === 'narrative')
    .map((s) => s.id)
  check('the live RCA template has narrative sections', sectionIds.length > 0, sectionIds)
  const SECTIONS = Object.fromEntries(
    sectionIds.map((id) => [id, { body: 'gate body', citations: [] }])
  )
  fs.writeFileSync(
    path.join(FAKE_DIR, `${SLUG}.json`),
    JSON.stringify({
      rca: {
        text:
          '```json\n' +
          JSON.stringify({
            rootCause: { findingId: null, statement: 'gate: unanchored root', evidence: [] },
            contributing: [],
            symptoms: [],
            ruledOut: [],
            duplicates: [],
            impact: '',
            timeline: [],
            remediation: { immediate: '', followUps: [] },
            execSummary: { whatBroke: '', impact: '', why: '', nextSteps: '' },
            techNarrative: [],
            sections: SECTIONS
          }) +
          '\n```'
      }
    })
  )

  // ---- session, model pin, evidence, open the case ----
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

  const COMPOSER = 'textarea[placeholder^="Message the analyst"]'
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
      () => conn.evalJs(`!!document.querySelector(${JSON.stringify(COMPOSER)})`),
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

  // ---- page-side readers ----
  const DOC = `document.querySelector('[data-testid="findings-document"]')`
  /** The document's cards in one section, DOM order: id, marginLeft, and the card's text. */
  const docSection = (label) =>
    conn.evalJs(`(() => {
      const doc = ${DOC}
      const sec = doc && doc.querySelector('section[aria-label=${JSON.stringify(label)}]')
      if (!sec) return null
      return [...sec.querySelectorAll(':scope > ul > li[data-finding-id]')].map((li) => ({
        id: Number(li.dataset.findingId),
        marginLeft: li.style.marginLeft,
        text: li.textContent.replace(/\\s+/g, ' ')
      }))
    })()`)
  /** The document's own header label (a sibling of the scroll box, not the rail's). */
  const docHeader = () =>
    conn.evalJs(`(() => {
      const doc = ${DOC}
      if (!doc) return null
      const el = [...doc.parentElement.querySelectorAll('div')].find((e) =>
        e.children.length === 0 && e.textContent.trim().startsWith('Findings'))
      return el ? el.textContent.trim() : null
    })()`)
  const docRuledOut = () =>
    conn.evalJs(`(() => {
      const doc = ${DOC}
      const b = doc && [...doc.querySelectorAll('button[aria-expanded]')].find((x) =>
        x.textContent.trim().startsWith('RULED OUT'))
      return b ? { text: b.textContent.trim(), expanded: b.getAttribute('aria-expanded') } : null
    })()`)
  const findingsTab = () =>
    conn.evalJs(`(() => {
      const b = document.querySelector('button[aria-label="Findings"]')
      if (!b) return null
      return { text: b.textContent.trim(), active: b.parentElement.className.includes('border-signal') }
    })()`)
  const walkBar = () =>
    conn.evalJs(`(() => {
      const doc = ${DOC}
      const bar = doc && doc.parentElement.querySelector('[data-testid="review-walk"]')
      return bar ? bar.textContent.split('·')[0].trim() : null
    })()`)

  // ---- 1. turn 1: a confirmed symptom caused by a hypothesis ----
  const row1 = await sendTurn(SID, TURN1, 'turn 1')
  mustSucceed(row1, 'turn 1')
  const f1 = findings()
  const SYM = f1.find((f) => f.role === 'symptom')
  const HYP = f1.find((f) => f.status === 'hypothesis')
  check(
    'turn 1: exactly two findings — a confirmed symptom caused_by a hypothesis',
    f1.length === 2 &&
      SYM &&
      HYP &&
      SYM.status === 'confirmed' &&
      SYM.caused_by === HYP.id &&
      HYP.role === 'contributing',
    f1.map((f) => `${f.id}:${f.status}:${f.role}:${f.caused_by}:${f.summary}`)
  )
  if (!SYM || !HYP) report()

  // ---- 2. turn 2: supersede with a sharper root cause, then replace_markdown ----
  const row2 = await sendTurn(SID, turn2(HYP.id), 'turn 2')
  mustSucceed(row2, 'turn 2')
  const f2 = findings()
  const NEW = f2.find((f) => f.id > SYM.id && f.id !== HYP.id && f.role === 'root-cause')
  if (!NEW) {
    check(
      'turn 2: a new confirmed root-cause finding',
      false,
      f2.map((f) => `${f.id}:${f.status}:${f.role}:${f.summary}`)
    )
    report()
  }
  const hyp2 = byId(HYP.id)
  const sym2 = byId(SYM.id)
  const block = findingBlock(NEW.id) ?? ''
  const markers = (findingsMd().match(/<!-- finding:/g) ?? []).length
  const updates = toolResults(SID, /update_finding$/).filter((e) => e.turnId === row2.id)
  check(
    'turn 2: a new confirmed root cause superseding the hypothesis; the symptom re-parented; the ' +
      'body replaced with [evidence/run.txt:2] (no ### Update); three markers in findings.md',
    f2.length === 3 &&
      NEW.status === 'confirmed' &&
      hyp2.superseded_by === NEW.id &&
      sym2.caused_by === NEW.id &&
      block.includes('[evidence/run.txt:2]') &&
      !/### Update/.test(block) &&
      markers === 3 &&
      updates.some((e) => !e.payload.isError),
    {
      rows: f2.map((f) => `${f.id}:${f.status}:${f.role}:${f.caused_by}:${f.superseded_by}`),
      markers,
      update: updates.map((e) => (e.payload.outputPreview ?? '').slice(0, 160)),
      blockTail: block.slice(-300)
    }
  )

  // ---- 3. the human accepts the root cause ----
  await conn.evalJs(`window.argus.findings.review(${NEW.id}, 'accepted').then(() => true)`)
  const acc3 = await waitFor(
    'DB root accepted by human',
    () => {
      const f = byId(NEW.id)
      return f.review_state === 'accepted' && f.review_actor === 'human' ? f : null
    },
    10000
  ).catch(() => byId(NEW.id))
  check(
    'human accept: the root cause is accepted by the human in the DB',
    acc3.review_state === 'accepted' && acc3.review_actor === 'human',
    acc3
  )

  // ---- 4. the Findings tab ----
  await conn.evalJs(
    `(() => { document.querySelector('button[aria-label="Findings"]').click(); return true })()`
  )
  const root4 = await waitFor(
    'the document ROOT CAUSE tree with two cards',
    async () => {
      const s = await docSection('ROOT CAUSE')
      return s && s.length === 2 ? s : null
    },
    20000
  ).catch(() => docSection('ROOT CAUSE'))
  const tab4 = await waitFor(
    'the Findings tab to count one pending',
    async () => {
      const t = await findingsTab()
      return t && t.text === 'Findings · 1' ? t : null
    },
    10000
  ).catch(() => findingsTab())
  const symPhrase = bodyPhrase(SYM.id, SYM.summary)
  const rootPhrase = bodyPhrase(NEW.id, NEW.summary)
  const ro4 = await docRuledOut()
  const header4 = await docHeader()
  const rootCard = root4?.[0]
  const symCard = root4?.[1]
  check(
    'Findings tab: the document shows ROOT CAUSE with the root at depth 0 and the symptom at 14px, ' +
      'both bodies open, RULED OUT · 1 collapsed, header Findings · 3 · 1 to review',
    tab4?.text === 'Findings · 1' &&
      tab4.active &&
      root4?.length === 2 &&
      rootCard.id === NEW.id &&
      rootCard.marginLeft === '' &&
      symCard.id === SYM.id &&
      symCard.marginLeft === '14px' &&
      !!rootPhrase &&
      rootCard.text.includes(rootPhrase) &&
      !!symPhrase &&
      symCard.text.includes(symPhrase) &&
      ro4?.text === 'RULED OUT · 1' &&
      ro4.expanded === 'false' &&
      header4 === 'Findings · 3 · 1 to review',
    {
      tab: tab4,
      cards: root4?.map((c) => ({
        id: c.id,
        marginLeft: c.marginLeft,
        text: c.text.slice(0, 160)
      })),
      rootPhrase,
      symPhrase,
      ruledOut: ro4,
      header: header4
    }
  )

  // ---- 5. the Review walk inside the document ----
  const clickedReview = await conn.evalJs(`(() => {
    const doc = ${DOC}
    const b = doc && doc.parentElement.querySelector('button[aria-label="Review pending findings"]')
    if (!b) return false
    b.click()
    return true
  })()`)
  const bar5 = await waitFor('the document walk bar', walkBar, 10000).catch(() => null)
  const focused5 = await conn.evalJs(
    `document.activeElement?.getAttribute('data-testid') === 'findings-document'`
  )
  await conn.evalJs(
    `document.activeElement.dispatchEvent(new KeyboardEvent('keydown', { key: 'a', bubbles: true, cancelable: true }))`
  )
  const acc5 = await waitFor(
    'DB symptom accepted by human',
    () => {
      const f = byId(SYM.id)
      return f.review_state === 'accepted' && f.review_actor === 'human' ? f : null
    },
    15000
  ).catch(() => byId(SYM.id))
  const gone5 = await waitFor(
    'walk bar gone',
    async () => ((await walkBar()) === null ? true : null),
    10000
  ).catch(() => false)
  check(
    'walk in the document: Reviewing 1 of 1, `a` accepts the symptom as the human, the walk ends',
    clickedReview &&
      bar5 === 'Reviewing 1 of 1' &&
      focused5 &&
      acc5.review_state === 'accepted' &&
      acc5.review_actor === 'human' &&
      gone5 === true,
    { clickedReview, bar: bar5, focused: focused5, symptom: acc5, ended: gone5 }
  )

  // ---- 6. Correct on the root card ----
  const clickedCorrect = await conn.evalJs(`(() => {
    const doc = ${DOC}
    const li = doc && doc.querySelector('li[data-finding-id="${NEW.id}"]')
    const b = li && li.querySelector('button[aria-label="Correct this finding"]')
    if (!b) return false
    b.click()
    return true
  })()`)
  const staged = `Finding #${NEW.id}: `
  const comp6 = await waitFor(
    'the composer to hold the handle and focus',
    async () => {
      const c = await conn.evalJs(`(() => {
        const t = document.querySelector(${JSON.stringify(COMPOSER)})
        return t ? { value: t.value, focused: document.activeElement === t } : null
      })()`)
      return c && c.value === staged && c.focused ? c : null
    },
    10000
  ).catch(() =>
    conn.evalJs(`(() => {
      const t = document.querySelector(${JSON.stringify(COMPOSER)})
      return t ? { value: t.value, focused: document.activeElement === t } : null
    })()`)
  )
  const tab6 = await findingsTab()
  const docGone6 = await conn.evalJs(`!${DOC}`)
  check(
    'Correct: back on Chat, the composer holds `Finding #N: ` and has focus',
    clickedCorrect && comp6?.value === staged && comp6.focused && tab6 && !tab6.active && docGone6,
    { clickedCorrect, composer: comp6, findingsTab: tab6, documentUnmounted: docGone6 }
  )

  // ---- 7. distill projection ----
  const jobsBefore = withDb((db) =>
    db.prepare(`SELECT COALESCE(MAX(id), 0) AS m FROM distill_jobs WHERE case_slug = ?`).get(SLUG)
  ).m
  await conn.evalJs(`window.argus.distill.redistill(${JSON.stringify(SLUG)}).then(() => true)`)
  await settle(DB, SLUG, true, 120000).catch((e) => console.error(`distill settle: ${e.message}`))
  const job7 = withDb((db) =>
    db
      .prepare(
        `SELECT id, state, error, input_snapshot FROM distill_jobs
          WHERE case_slug = ? AND id > ? ORDER BY id DESC LIMIT 1`
      )
      .get(SLUG, jobsBefore)
  )
  const snap = job7 ? JSON.parse(job7.input_snapshot) : null
  const sf = (id) => snap?.findings?.find((f) => f.id === id) ?? null
  const hyp7 = sf(HYP.id)
  const root7 = sf(NEW.id)
  const sym7 = sf(SYM.id)
  check(
    'distill snapshot: the hypothesis supersededBy the root with an empty body; the root ' +
      'confirmed / root-cause / roleSource agent; the symptom causedBy the root',
    hyp7?.supersededBy === NEW.id &&
      hyp7.body === '' &&
      root7?.status === 'confirmed' &&
      root7.role === 'root-cause' &&
      root7.roleSource === 'agent' &&
      sym7?.causedBy === NEW.id,
    { job: job7 && { id: job7.id, state: job7.state }, hyp: hyp7, root: root7, symptom: sym7 }
  )

  // ---- 8. RCA anchoring ----
  await conn.evalJs(`window.argus.rca.generate(${JSON.stringify(SLUG)}).then(() => true)`)
  const rcaStatus = () => conn.evalJs(`window.argus.rca.status(${JSON.stringify(SLUG)})`)
  const st8 = await waitFor(
    'the RCA job to finish',
    async () => {
      const s = await rcaStatus()
      const state = s?.job?.state
      if (state === 'failed') abort(`RCA FAIL: job failed: ${s.job.error}`)
      return state === 'done' ? s : null
    },
    60000
  ).catch(() => rcaStatus())
  const expected = {
    unanchored: { rootCause: 1, contributing: 0, symptoms: 0, ruledOut: 0 },
    // draftAnchoring sorts ascending: the symptom was recorded before the root cause.
    unused: [NEW.id, SYM.id].sort((a, b) => a - b)
  }
  await conn.evalJs(`(() => {
    const b = document.querySelector('button[aria-label="RCA report"]')
    if (!b) return false
    b.click()
    return true
  })()`)
  const line8 = await waitFor(
    'the RCA panel anchoring line',
    () =>
      conn.evalJs(`document.querySelector('[data-testid="rca-anchoring"]')?.textContent ?? null`),
    20000
  ).catch(() => null)
  check(
    'RCA: the payload counts one unanchored root and the two active findings unused; the panel ' +
      'reads 1 statement without a finding · 2 findings not used',
    st8?.job?.state === 'done' &&
      JSON.stringify(st8.anchoring) === JSON.stringify(expected) &&
      line8 === '1 statement without a finding · 2 findings not used',
    { state: st8?.job?.state, anchoring: st8?.anchoring, expected, panel: line8 }
  )

  // ---- 9. turn 3: the agent hears the accepts and leaves them ----
  const row3 = await sendTurn(SID, TURN3, 'turn 3')
  const reply3 = mirror(SID)
    .filter((e) => e.type === 'assistant.message' && e.turnId === row3.id)
    .map((e) => e.payload.text)
    .join('\n')
  const namesRoot =
    new RegExp(`#${NEW.id}\\b|finding ${NEW.id}\\b`, 'i').test(reply3) ||
    reply3.toLowerCase().includes(NEW.summary.toLowerCase().slice(0, 40))
  const end = [byId(NEW.id), byId(SYM.id)]
  check(
    'turn 3: succeeded, the reply names the root cause, both human accepts survive',
    row3.status === 'success' &&
      namesRoot &&
      end.every((f) => f.review_state === 'accepted' && f.review_actor === 'human'),
    { status: row3.status, reply: reply3.slice(0, 400), rows: end }
  )

  const models = [
    ...new Set(
      mirror(SID)
        .map((e) => e.payload?.model)
        .filter((m) => typeof m === 'string')
    )
  ]
  const cost = withDb(
    (db) =>
      db.prepare(`SELECT COALESCE(SUM(cost_usd),0) AS c FROM turns WHERE session_id = ?`).get(SID).c
  )
  console.error(
    `spend: $${Number(cost).toFixed(3)} over 3 turns (pinned ${MODEL}; reported ${models.join(', ') || 'n/a'}); log ${LOG}`
  )
  report()
}

main().catch((err) => {
  console.error(err)
  process.exit(1)
})
