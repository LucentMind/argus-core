#!/usr/bin/env node
/**
 * RCA increment 3 runtime gate — editing the report before it posts to Jira
 * (plan argus-docs/superpowers/plans/2026-08-14-rca-increment-3-editing-before-jira.md, Exit check).
 *
 * The renderer suite proves the toggles, the editor and the warnings against a mocked
 * `window.argus`. It cannot prove the thing the increment actually promises: that dropping a
 * section and hand-editing the markdown changes the BYTES ON DISK that `post.ts` reads. That path
 * — panel state → `rca:confirm` / `rca:save-markdown` → `artifacts.ts` → the file — exists only in
 * the real app, and every jsdom test stubs it at the first hop.
 *
 * What this gate answers, and nothing else:
 *   1. the drop toggles list the snapshot template's sections, per report
 *   2. dropping exec Impact removes it from the exec preview and leaves the technical one alone
 *   3. Confirm & freeze writes that drop through to artifacts/rca-exec.md ON DISK
 *   4. Edit opens on the on-disk markdown, and Save writes the edited bytes to that same file
 *   5. a hand-edited report shows the `edited` badge AND displays the on-disk text, not a re-render
 *   6. Confirm & freeze warns before discarding edits; Cancel leaves the file untouched
 *   7. accepting the warning restores the rendered bytes and clears the badge
 *   8. Regenerate warns first too
 *   9. linking a Jira issue AFTER confirming does NOT make an untouched report read as edited
 *      (the caseMeta snapshot fix — this one used to fail)
 *
 * NOT covered here: the actual post to Jira. That is an outbound write to a real external
 * service; it needs a human's go-ahead, so the gate stops at the artifact bytes. Step 4 of the
 * plan's exit check ("the comment carries your edited sentence") remains unverified by this run —
 * `rca.post.test.ts` covers the same join with a fake Jira client instead.
 *
 * Usage:
 *   1. ARGUS_HOME=<scratch> npx electron-vite dev --remoteDebuggingPort 9241
 *   2. ARGUS_HOME=<scratch> node scripts/rca-editing-fixture.mjs
 *   3. ARGUS_HOME=<scratch> node scripts/cdp-rca-editing.mjs
 *
 * Env: CDP_PORT (default 9241), ARGUS_HOME (required — the gate reads artifacts off disk).
 * Exits 0 when every assertion passes, 1 otherwise.
 */
import fs from 'node:fs'
import path from 'node:path'
import {
  listTargets as list,
  connect,
  sleep,
  waitFor,
  check,
  report,
  mainWindow
} from './lib/cdp.mjs'

const PORT = process.env.CDP_PORT || '9241'
const HOME = process.env.ARGUS_HOME
if (!HOME) throw new Error('ARGUS_HOME is required — the gate reads the artifacts off disk')

const SLUG = 'rca-edit-gate'
const META_SLUG = 'rca-meta-gate'
const artifact = (slug, kind) => path.join(HOME, 'cases', slug, 'artifacts', `rca-${kind}.md`)
const readArtifact = (slug, kind) =>
  fs.existsSync(artifact(slug, kind)) ? fs.readFileSync(artifact(slug, kind), 'utf8') : null

const targets = await list(PORT)
if (targets.length === 0) throw new Error(`no page target on CDP port ${PORT}`)
const main = await connect(mainWindow(targets) ?? targets[0])

/* ------------------------------------------------------------------ *
 * 0. IDENTITY — hard gate, before any measurement.
 *
 * Every worktree may have a dev instance up, and a debug port that is already taken answers
 * with SOMEONE ELSE'S window without saying so. Advice to "preflight identity" does not survive
 * contact; this is the assertion that does. Abort rather than report confident findings about
 * code this run never loaded.
 * ------------------------------------------------------------------ */
const slugs = await main.evalJs(`window.argus.cases.list().then(cs => cs.map(c => c.slug).sort())`)
if (!Array.isArray(slugs) || !slugs.includes(SLUG) || !slugs.includes(META_SLUG)) {
  console.error(
    `ABORT: port ${PORT} is not this worktree's app — cases were ${JSON.stringify(slugs)}`
  )
  process.exit(2)
}
check('identity: the fixture home is the one on screen', true, slugs)

/**
 * Dismiss any confirm dialog a previous run left open, so re-running the gate answers the same
 * question. A modal left up blocks the Home navigation below and every later assertion fails for
 * a reason that has nothing to do with the product.
 */
await main.evalJs(`(() => {
  const stray = [...document.querySelectorAll('[role="dialog"]')]
    .filter(e => e.getAttribute('aria-label') !== 'RCA report')
  for (const d of stray) {
    const c = [...d.querySelectorAll('button')].find(b => /^cancel$/i.test(b.innerText.trim()))
    if (c) c.click()
  }
  return stray.length
})()`)

const click = (label) =>
  main.evalJs(`(() => {
    const b = [...document.querySelectorAll('button')].find(
      e => (e.getAttribute('aria-label') || e.innerText.trim()) === ${JSON.stringify(label)})
    if (b) b.click()
    return !!b
  })()`)

const clickMatching = (re) =>
  main.evalJs(`(() => {
    const b = [...document.querySelectorAll('button')].find(
      e => ${re}.test(e.getAttribute('aria-label') || e.innerText.trim()))
    if (b) b.click()
    return b ? (b.getAttribute('aria-label') || b.innerText.trim()) : null
  })()`)

const bodyText = () => main.evalJs(`document.body.innerText`)

/**
 * Find a drop toggle by its aria-label with a JS filter, NOT a CSS attribute selector.
 * `[aria-label='...']` needs quotes inside a string that is already quoted, and the nested pair
 * ends the JS string early — the page reports `SyntaxError: missing ) after argument list`,
 * which reads like the app is broken when it is the probe that is.
 */
const findToggle = (label) =>
  `[...document.querySelectorAll('input[type=checkbox]')].find(i => i.getAttribute('aria-label') === ${JSON.stringify(label)})`

const toggleState = (label) =>
  main.evalJs(`(() => { const i = ${findToggle(label)}; return i ? i.checked : null })()`)

/** Open a case from Home and open its RCA panel. The card's handler sits on an ancestor of
 *  [data-testid="case-title"], not on a button. */
async function openPanel(slug, title) {
  await click('All cases')
  await sleep(700)
  await main.evalJs(`(() => {
    const t = [...document.querySelectorAll('[data-testid="case-title"]')].find(
      e => e.innerText.includes(${JSON.stringify(title)}))
    if (!t) return false
    let el = t
    for (let i = 0; i < 6 && el; i++) {
      if (el.className && String(el.className).includes('cursor')) break
      el = el.parentElement
    }
    ;(el || t).click()
    return true
  })()`)
  await sleep(1400)
  await click('RCA report')
  // NAVIGATE FIRST, AND PROVE IT — otherwise every assertion below runs against whatever
  // screen the app happened to be on, and passes by describing nothing.
  await waitFor(`${slug}: the RCA panel to be on screen`, async () =>
    (await bodyText()).includes('the cache key omitted the tenant id')
  )
}

/* ================= PHASE A — drop a section, confirm, check the file ================= */
await openPanel(SLUG, 'Cross-tenant cache leak')
check('A1 panel opens on the seeded draft', true)

const EXEC_IMPACT = 'Include Impact in the executive summary'
const TECH_IMPACT = 'Include Impact in the technical report'
check('A2 exec Impact toggle exists and starts included', (await toggleState(EXEC_IMPACT)) === true)
check('A3 the two reports have separate Impact toggles', (await toggleState(TECH_IMPACT)) === true)

await main.evalJs(`${findToggle(EXEC_IMPACT)}.click()`)
await sleep(1200)
check('A4 exec Impact is now dropped', (await toggleState(EXEC_IMPACT)) === false)
check(
  'A5 tech Impact is untouched — the drop sets are per report',
  (await toggleState(TECH_IMPACT)) === true
)

/** The preview body for the active tab. Asserted on a HEADING, not the word "Impact", which also
 *  appears in prose. Headings render as `## Impact` → an <h2>. */
const previewHeadings = () =>
  main.evalJs(`(() => {
    const hs = [...document.querySelectorAll('h1,h2,h3')].map(h => h.innerText.trim())
    return hs
  })()`)

await waitFor(
  'A6 exec preview to lose the Impact heading',
  async () => !(await previewHeadings()).includes('Impact')
)
check('A6 exec preview no longer shows an Impact heading', true, await previewHeadings())

await click('Technical report')
await sleep(1000)
check(
  'A7 the technical preview still has its own Impact heading',
  (await previewHeadings()).includes('Impact'),
  await previewHeadings()
)
await click('Exec summary')
await sleep(600)

await click('Confirm & freeze')
await sleep(400)
// The no-root-cause dialog does not fire (the draft has one), and nothing is hand-edited yet,
// so no discard warning either — confirm should go straight through.
await waitFor('A8 the confirm to land', async () => readArtifact(SLUG, 'exec') !== null, 25000)

const execAfterConfirm = readArtifact(SLUG, 'exec')
const techAfterConfirm = readArtifact(SLUG, 'tech')
check('A8 artifacts/rca-exec.md exists on disk after Confirm & freeze', Boolean(execAfterConfirm))
check(
  'A9 the dropped section is absent from the FILE, not just the preview',
  !/^## Impact$/m.test(execAfterConfirm ?? ''),
  (execAfterConfirm ?? '').slice(0, 160)
)
check(
  'A10 the technical file kept its own Impact section',
  /^## Impact$/m.test(techAfterConfirm ?? '')
)

/* ================= PHASE B — hand-edit the markdown ================= */
await waitFor(
  'B1 the Edit button to appear once confirmed',
  async () =>
    await main.evalJs(
      `[...document.querySelectorAll('button')].some(b => /^edit$/i.test(b.innerText.trim()))`
    )
)
await clickMatching('/^edit$/i')
await sleep(900)

const editorValue = () =>
  main.evalJs(`(() => {
    const t = document.querySelector('textarea[aria-label$="markdown"]')
    return t ? t.value : null
  })()`)
check(
  'B1 the editor opens on the ON-DISK exec markdown',
  (await editorValue()) === execAfterConfirm,
  { editorLen: (await editorValue())?.length, fileLen: execAfterConfirm?.length }
)

const EDITED = '# Hand written by the gate\n\nThis sentence proves the edit reaches the file.\n'
await main.evalJs(`(() => {
  const t = document.querySelector('textarea[aria-label$="markdown"]')
  const setter = Object.getOwnPropertyDescriptor(window.HTMLTextAreaElement.prototype, 'value').set
  setter.call(t, ${JSON.stringify(EDITED)})
  t.dispatchEvent(new Event('input', { bubbles: true }))
  return t.value.length
})()`)
await clickMatching('/^save$/i')
await waitFor(
  'B2 the edited bytes to reach the file',
  async () => readArtifact(SLUG, 'exec') === EDITED,
  20000
)
check('B2 Save writes the edited bytes verbatim to artifacts/rca-exec.md', true)

await waitFor('B3 the edited badge', async () => /\bedited\b/i.test(await bodyText()))
check('B3 a hand-edited report shows the edited badge', true)
check(
  'B4 the pane shows the ON-DISK text, not a fresh render',
  (await bodyText()).includes('This sentence proves the edit reaches the file')
)

/* ================= PHASE C — the discard warnings ================= */
/**
 * The confirm dialog's text — explicitly NOT the RCA panel's.
 *
 * `RcaPanel` is itself a `ModalShell`, so it carries `role="dialog"` with aria-label "RCA report"
 * and `querySelector('[role="dialog"]')` returns the PANEL. Reading that instead of the warning
 * makes a fired warning look like no warning at all, which cost a debugging cycle here. Select
 * the dialog that is not the panel.
 */
const dialogText = () =>
  main.evalJs(`(() => {
    const d = [...document.querySelectorAll('[role="dialog"]')]
      .filter(e => e.getAttribute('aria-label') !== 'RCA report')
    return d.length ? d[d.length - 1].innerText : null
  })()`)

await click('Confirm & freeze')
await waitFor('C1 the discard warning', async () => {
  const t = await dialogText()
  return t && /text edits/i.test(t)
})
check(
  'C1 Confirm & freeze warns before discarding text edits',
  true,
  (await dialogText())?.slice(0, 140)
)
check('C2 the warning names the Jira comment', /jira comment/i.test((await dialogText()) ?? ''))

await clickMatching('/^cancel$/i')
await sleep(900)
check('C3 cancelling leaves the hand-edited file untouched', readArtifact(SLUG, 'exec') === EDITED)

await click('Confirm & freeze')
await waitFor('C4 the warning again', async () => /text edits/i.test((await dialogText()) ?? ''))
await clickMatching('/^confirm$/i')
await waitFor(
  'C4 the rendered bytes to come back',
  async () => readArtifact(SLUG, 'exec') !== EDITED,
  20000
)
check('C4 accepting the warning restores the rendered report', true)
check(
  'C5 the restored file is the render, still without the dropped section',
  !/^## Impact$/m.test(readArtifact(SLUG, 'exec') ?? '') &&
    (readArtifact(SLUG, 'exec') ?? '').startsWith('# RCA')
)
await waitFor(
  'C6 the edited badge to clear',
  async () => !/\bedited\b/i.test(await bodyText()),
  15000
)
check('C6 the edited badge clears once the file matches the render again', true)

/* --- Regenerate warns too. Re-edit first, so there is something to lose. --- */
await clickMatching('/^edit$/i')
await sleep(800)
await main.evalJs(`(() => {
  const t = document.querySelector('textarea[aria-label$="markdown"]')
  const setter = Object.getOwnPropertyDescriptor(window.HTMLTextAreaElement.prototype, 'value').set
  setter.call(t, ${JSON.stringify(EDITED)})
  t.dispatchEvent(new Event('input', { bubbles: true }))
})()`)
await clickMatching('/^save$/i')
await waitFor('C7 the re-edit to land', async () => readArtifact(SLUG, 'exec') === EDITED, 20000)
/**
 * Wait for the BADGE, not just the file.
 *
 * `saveMarkdown` writes the file and only then does `saveEditor` re-derive `handEdited` over a
 * second IPC round trip. Polling the file alone leaves a window where main knows the report is
 * edited but the panel does not, and a click landing in it gets the plain regenerate dialog
 * instead of the discard warning — which reads exactly like the warning is missing. Assert the
 * precondition the behaviour depends on (the panel knows) before exercising the behaviour.
 */
await waitFor('C7 the panel to know the report is edited again', async () =>
  /\bedited\b/i.test(await bodyText())
)

await click('Regenerate')
await waitFor(
  'C7 the regenerate warning',
  async () => /text edits/i.test((await dialogText()) ?? ''),
  15000
)
check('C7 Regenerate warns before discarding text edits, before regenerating', true)
await clickMatching('/^cancel$/i')
await sleep(800)
check('C8 cancelling Regenerate leaves the file untouched', readArtifact(SLUG, 'exec') === EDITED)

/* ================= PHASE D — the caseMeta snapshot fix ================= */
/**
 * The regression this closes: confirm an RCA, THEN link the Jira issue — which you must do
 * before you can post at all — and the re-render used to pick up the new `Jira: KEY` line that
 * the file on disk does not have, so BOTH untouched reports reported edited.
 */
await openPanel(META_SLUG, 'Meta snapshot check')
await click('Confirm & freeze')
await waitFor(
  'D1 the meta case to confirm',
  async () => readArtifact(META_SLUG, 'exec') !== null,
  25000
)
const metaExec = readArtifact(META_SLUG, 'exec')
check(
  'D1 the meta case confirmed with no Jira key',
  Boolean(metaExec) && !/^Jira:/m.test(metaExec ?? '')
)

const before = await main.evalJs(`window.argus.rca.handEdited(${JSON.stringify(META_SLUG)})`)
check(
  'D2 nothing is hand-edited right after confirm',
  before?.exec === false && before?.tech === false,
  before
)

/**
 * Set the key by writing the case row, NOT through the app's own control.
 *
 * `setCaseJira` is reachable only from `jiraCases.ts`, i.e. behind a live Jira connection — an
 * outbound dependency this gate deliberately does not take. The row write is what that path
 * ultimately performs, and what matters here is downstream of it: `handEditedReports` reads the
 * case row fresh on every call, so this reproduces the regression's input exactly. The assertion
 * below is on MAIN's answer over IPC, not on rendered DOM, so no React state is being faked.
 */
const linked = await main.evalJs(
  `window.argus.rca.handEdited(${JSON.stringify(META_SLUG)}).then(() => 'ok')`
)
check('D3 main is responsive before the row write', linked === 'ok', linked)
{
  const { DatabaseSync } = await import('node:sqlite')
  const wdb = new DatabaseSync(path.join(HOME, 'argus.db'))
  wdb.prepare(`UPDATE cases SET jira_key = ? WHERE slug = ?`).run('LINKED-9', META_SLUG)
  const row = wdb.prepare(`SELECT jira_key FROM cases WHERE slug = ?`).get(META_SLUG)
  wdb.close()
  check(
    'D3 the case now carries a Jira key it did not have at confirm',
    row?.jira_key === 'LINKED-9',
    row
  )
}

const after = await main.evalJs(`window.argus.rca.handEdited(${JSON.stringify(META_SLUG)})`)
check(
  'D4 linking Jira AFTER confirming does not make untouched reports read as edited',
  after?.exec === false && after?.tech === false,
  after
)
check(
  'D5 the file on disk really is unchanged (so D4 is not passing vacuously)',
  readArtifact(META_SLUG, 'exec') === metaExec
)

/**
 * D6 — MUTATION CHECK. Without this, D4 is just an assertion that something did not happen, and
 * would pass equally against a build where the whole feature was missing.
 *
 * Nulling `meta_snapshot` puts the row back in its pre-fix shape: `handEditedReports` then falls
 * back to LIVE case meta, which IS the old behaviour. If the fix is load-bearing, both reports
 * must flip to edited here — and flip back when the snapshot is restored. This also exercises
 * the documented NULL fallback against the real app, which nothing else does.
 */
{
  const { DatabaseSync } = await import('node:sqlite')
  const wdb = new DatabaseSync(path.join(HOME, 'argus.db'))
  const q = `SELECT meta_snapshot FROM rca_jobs WHERE case_slug = ? AND confirmed_at IS NOT NULL ORDER BY id DESC LIMIT 1`
  const saved = wdb.prepare(q).get(META_SLUG)?.meta_snapshot
  wdb.prepare(`UPDATE rca_jobs SET meta_snapshot = NULL WHERE case_slug = ?`).run(META_SLUG)
  const nulled = await main.evalJs(`window.argus.rca.handEdited(${JSON.stringify(META_SLUG)})`)
  check(
    'D6 without the snapshot the SAME untouched files read as edited — D4 is not vacuous',
    nulled?.exec === true && nulled?.tech === true,
    nulled
  )
  wdb.prepare(`UPDATE rca_jobs SET meta_snapshot = ? WHERE case_slug = ?`).run(saved, META_SLUG)
  const restored = await main.evalJs(`window.argus.rca.handEdited(${JSON.stringify(META_SLUG)})`)
  check(
    'D7 restoring the snapshot makes them read clean again (NULL fallback, both directions)',
    restored?.exec === false && restored?.tech === false,
    restored
  )
  wdb.close()
}

/** And the function is not simply blind now: a real edit is still caught after the meta change. */
fs.writeFileSync(artifact(META_SLUG, 'exec'), '# genuinely hand written\n')
const afterEdit = await main.evalJs(`window.argus.rca.handEdited(${JSON.stringify(META_SLUG)})`)
check(
  'D8 a genuine hand-edit is still detected after the meta change',
  afterEdit?.exec === true && afterEdit?.tech === false,
  afterEdit
)

main.close()
report()
