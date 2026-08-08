#!/usr/bin/env node
/**
 * Routines increment 5 runtime gate — the ITEM LOOP
 * (spec argus-docs/superpowers/specs/2026-08-08-routines-increment-5-design.md, task 17).
 *
 * Everything increment 5 ships is proven only by jsdom and DI fakes: the item loop runs against
 * an injected `runTurn`, the scope resolver is a fake, `propose_case_triage` is called by a
 * capturing driver, and the Draft badge is asserted against a hand-built payload. None of that
 * touches the real chain
 *
 *   IPC -> RoutinesService.executeItems -> createRoutineTurnRunner -> runBackgroundTurn
 *       -> CaseSession(currentRunItemId) -> the real Claude driver -> propose_case_triage
 *       -> routine_run_items -> routines:changed -> RoutineInbox / CaseCard
 *
 * and every link in it is one this branch built. This drives the real app over CDP.
 *
 * ── WHAT THIS GATE CAN AND CANNOT CHECK ─────────────────────────────────────────────────────
 *
 * There are NO Atlassian credentials and no configured defect-corpus source in the environment
 * this gate was written and first run in. Two of the seven assertions the task brief asks for
 * therefore CANNOT be made here, and they are reported as SKIP — never folded into the pass
 * tally. A gate that reports "12/12 PASS" while silently skipping two is worse than no gate.
 *
 *   RUNNABLE   the whole item loop, through a `cases` scope, which needs no network at all:
 *              cap + carry-over, per-item failure isolation, drafts, accept/dismiss, the inbox
 *              rows, and the unscoped regression guard for increments 1-3.
 *   SKIPPED    a real `jira-jql` scope (the `/rest/api/3/search/jql` endpoint shape is
 *              DOCUMENTED BUT UNVERIFIED — the single largest outstanding risk on this branch),
 *              and `search_known_defects` returning real corpus hits inside a routine turn.
 *
 * ── HOW THE DELIBERATE FAILURE IS INJECTED ──────────────────────────────────────────────────
 *
 * The brief's example (a Jira attachment that 404s) needs Jira. The `cases`-scope equivalent
 * used here is a case whose ROW is intact but whose on-disk directory has been replaced by a
 * FILE. That is not a contrived poke at a private seam: `createRoutineTurnRunner` calls
 * `materializeSessionSkills`, which `mkdirSync`s `<caseDir>/.claude/skills` — and mkdir under a
 * path whose ancestor is a regular file throws. The throw lands in `executeItems`' per-item
 * try/catch, which is exactly the production path a real ingest failure takes.
 *
 * It is injected BEFORE the run starts rather than racing a live turn, so the gate is
 * deterministic: the row is still a candidate (resolution is pure SQL over `cases`), the case's
 * `updated_at` is never moved (the turn dies before the session is used), and item B is item 2
 * of 3 — so the items BEHIND it are what prove a failure does not block the rest.
 *
 * ── USAGE ───────────────────────────────────────────────────────────────────────────────────
 *
 *   1. Pick a FRESH, EMPTY scratch home. This gate refuses to run against a home that already
 *      carries routines or runs — see the freshness preflight — because an assertion that is
 *      true on a fresh home and false on a re-run is a broken gate, not a flaky one.
 *
 *        cd app
 *        ARGUS_HOME=/tmp/argus-items-gate npx electron-vite dev --remoteDebuggingPort 9229
 *
 *   2. ARGUS_HOME=/tmp/argus-items-gate node scripts/cdp-routines-items.mjs
 *
 * `ARGUS_HOME` must be set for THIS script too, and to the same directory: the script reads and
 * writes that home directly (it is what injects the failure above), and it VERIFIES from the
 * app that the home really took effect rather than assuming — see `confirmHome`.
 *
 * Env: CDP_PORT (default 9229 — deliberately not the 9227 the increment-3 gates use, so both
 * can be running), ITEM_TURN_TIMEOUT_MS (default 900000 for a whole multi-item run).
 *
 * Exits 0 when every non-skipped assertion passes, 1 otherwise. Skips never affect the code.
 */
import { execFileSync } from 'node:child_process'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { dirname, resolve as resolvePath } from 'node:path'
import { listTargets as list, connect, sleep, waitFor, mainWindow } from './lib/cdp.mjs'

const PORT = process.env.CDP_PORT || '9229'
const HOME = process.env.ARGUS_HOME
const RUN_TIMEOUT_MS = Number(process.env.ITEM_TURN_TIMEOUT_MS || 900_000)

const ROUTINE = 'item-gate'
const UNSCOPED = 'unscoped-gate'
/** Item A processes, B is the broken one, C proves a failure does not block what is behind it,
 *  D is over the cap and must be what — and all that — run 2 picks up. */
const CASES = ['gate-item-a', 'gate-item-b', 'gate-item-c', 'gate-item-d']
const [A, B, C, D] = CASES
const SUGGESTED_TITLE = 'Gate item, triaged by the routine'
const SUGGESTED_TAGS = ['severity:low', 'component:itemgate']

// This file lives at <worktree>/app/scripts/ — two levels up is the worktree root, derived so
// the port-ownership check below is correct under any worktree's path.
const WORKTREE_ROOT = resolvePath(dirname(fileURLToPath(import.meta.url)), '..', '..')

// ── tally ───────────────────────────────────────────────────────────────────────────────────
/**
 * A local tally rather than lib/cdp.mjs's `check`/`report`, for one reason: this gate has to
 * report SKIPPED assertions, and a skip must be visible AND must not count toward the pass
 * tally. `report()` there has no third state and its `assertions` array is module-private, so a
 * skip could only be expressed by lying (counting it as a pass) or by hiding it (not calling
 * anything). Both are the failure mode this file exists to avoid.
 */
const results = []
const check = (name, pass, detail) => {
  results.push({ name, state: pass ? 'pass' : 'fail' })
  console.error(
    `${pass ? 'PASS' : 'FAIL'}  ${name}${detail !== undefined ? ` — ${JSON.stringify(detail)}` : ''}`
  )
}
/** An assertion this environment cannot make. `why` is printed, always — a silent skip is the
 *  thing that makes a green gate meaningless. */
const skip = (name, why) => {
  results.push({ name, state: 'skip' })
  console.error(`SKIP  ${name}\n        reason: ${why}`)
}
const report = () => {
  const pass = results.filter((r) => r.state === 'pass').length
  const fail = results.filter((r) => r.state === 'fail').length
  const skipped = results.filter((r) => r.state === 'skip')
  console.error(`\n${pass}/${pass + fail} assertions passed, ${skipped.length} SKIPPED`)
  for (const s of skipped) console.error(`  SKIPPED: ${s.name}`)
  if (fail) {
    console.error('\nfailed:')
    for (const f of results.filter((r) => r.state === 'fail')) console.error(`  ${f.name}`)
  }
  process.exit(fail ? 1 : 0)
}
const die = (msg) => {
  console.error(`\nPRECONDITION NOT MET — nothing was asserted.\n${msg}`)
  process.exit(2)
}

// ── 0. preflight: the port, the home, and a fresh database ──────────────────────────────────

/** Run a PowerShell one-liner, or null if the shell could not be spawned. `NOMATCH` sentinel so
 *  "no such process" is a clean string on stdout rather than a throw to disambiguate. */
const runPowershell = (script) => {
  try {
    return execFileSync('powershell', ['-NoProfile', '-Command', script], {
      encoding: 'utf8',
      timeout: 5000
    }).trim()
  } catch {
    return null
  }
}

const resolveListeningPid = (port) => {
  if (process.platform === 'win32') {
    const out = runPowershell(
      `try { $r = Get-NetTCPConnection -LocalPort ${port} -State Listen -ErrorAction Stop | ` +
        `Select-Object -First 1 -ExpandProperty OwningProcess; if ($r) { Write-Output $r } ` +
        `else { Write-Output 'NOMATCH' } } catch { Write-Output 'NOMATCH' }`
    )
    if (out === null || out === 'NOMATCH' || out === '') return null
    const pid = Number.parseInt(out, 10)
    return Number.isFinite(pid) ? pid : null
  }
  if (process.platform === 'darwin' || process.platform === 'linux') {
    try {
      const out = execFileSync('lsof', ['-ti', `tcp:${port}`, '-sTCP:LISTEN'], {
        encoding: 'utf8',
        timeout: 5000
      }).trim()
      const pid = Number.parseInt(out.split(/\s+/)[0], 10)
      return Number.isFinite(pid) ? pid : null
    } catch {
      return null
    }
  }
  return null
}

const resolveCommandLine = (pid) => {
  if (process.platform === 'win32') {
    const out = runPowershell(
      `try { $r = Get-CimInstance Win32_Process -Filter 'ProcessId=${pid}' -ErrorAction Stop | ` +
        `Select-Object -ExpandProperty CommandLine; if ($r) { Write-Output $r } ` +
        `else { Write-Output 'NOMATCH' } } catch { Write-Output 'NOMATCH' }`
    )
    return out === null || out === 'NOMATCH' || out === '' ? null : out
  }
  if (process.platform === 'darwin' || process.platform === 'linux') {
    try {
      return (
        execFileSync('ps', ['-o', 'command=', '-p', String(pid)], {
          encoding: 'utf8',
          timeout: 5000
        }).trim() || null
      )
    } catch {
      return null
    }
  }
  return null
}

/**
 * Concurrent worktree sessions collide on a shared debug port. The LOSER binds nothing — its app
 * runs with no debugging at all — and a gate that only checks "some CDP endpoint answered" then
 * silently drives the OTHER branch's app and reports green about code it never touched.
 *
 * A mismatch is the one outcome that must never pass silently, so it is the one that hard-fails.
 * Every other outcome (unsupported platform, a PID whose command line will not resolve) warns
 * and proceeds: being unable to check ownership is not evidence of the wrong worktree.
 */
const verifyPortOwnership = (port) => {
  const plat = process.platform
  if (plat !== 'win32' && plat !== 'darwin' && plat !== 'linux') {
    console.error(`WARNING: cannot verify port ${port} ownership on "${plat}" — unchecked.`)
    return
  }
  const pid = resolveListeningPid(port)
  if (pid === null) return // "nothing is listening"; the endpoint check below says so clearly
  const cmdLine = resolveCommandLine(pid)
  if (!cmdLine) {
    console.error(`WARNING: PID ${pid} holds port ${port} but its command line is unreadable.`)
    return
  }
  const matches =
    plat === 'win32'
      ? cmdLine.toLowerCase().includes(WORKTREE_ROOT.toLowerCase())
      : cmdLine.includes(WORKTREE_ROOT)
  if (!matches) {
    die(
      `Port ${port} is answering, but not from this worktree.\n` +
        `  Expected worktree: ${WORKTREE_ROOT}\n` +
        `  Actual process (PID ${pid}): ${cmdLine}\n` +
        `Another worktree is holding this port. Free it, or run the app under test with a ` +
        `different --remoteDebuggingPort and set CDP_PORT to match.`
    )
  }
  console.error(`port ${port} is held by this worktree (PID ${pid})`)
}

if (!HOME) {
  die(
    'ARGUS_HOME is not set for this script.\n' +
      'It must name the SAME isolated home the app under test was launched with — this gate\n' +
      'reads and writes that home directly to inject the deliberate item failure.'
  )
}
verifyPortOwnership(PORT)

let targets
try {
  targets = await list(PORT)
} catch {
  die(`No CDP endpoint on ${PORT}. Start the app with --remoteDebuggingPort ${PORT}.`)
}
if (targets.length === 0) die(`Port ${PORT} answered but exposed no page target.`)
const main = await connect(mainWindow(targets) ?? targets[0])

const payload = () => main.evalJs(`window.argus.routines.list()`)
const caseList = () => main.evalJs(`window.argus.cases.list()`)
const caseBySlug = async (slug) => (await caseList()).find((c) => c.slug === slug) ?? null

/**
 * FRESHNESS, not idempotence-by-cleanup. Half of what this gate asserts is about what a SECOND
 * run of a routine does differently from the first (carry-over, draft-skip, the last-attempt
 * filter), so a home that already carries runs would make run 1's assertions describe run N. The
 * honest response is to refuse, loudly, rather than to half-clean and assert against a state
 * nobody can reason about. Two runs against two fresh homes are identical; that is the property
 * that matters.
 */
const fresh = await payload()
if (fresh.routines.length || fresh.runs.length) {
  die(
    `${HOME} is not a fresh home: it already carries ${fresh.routines.length} routine(s) and ` +
      `${fresh.runs.length} run(s).\nPoint ARGUS_HOME at an empty scratch directory, relaunch ` +
      `the app against it, and re-run.`
  )
}

/**
 * CONFIRM the home rather than assume it. `ARGUS_HOME` set for this script says nothing about
 * what the APP is using — the two are separate processes and a mismatch presents as "every
 * assertion failed for no reason". Creating a case through the app's own IPC and then finding
 * its directory on disk under OUR home is a positive, two-sided proof.
 */
const confirmHome = async () => {
  await main.evalJs(
    `window.argus.cases.create({ slug: ${JSON.stringify(A)}, title: 'Gate item A' })`
  )
  return fs.existsSync(path.join(HOME, 'cases', A, 'case.json'))
}
check('the app is using the ARGUS_HOME this script was given', await confirmHome(), HOME)

// ── 1. seed the scope, and break exactly one item ───────────────────────────────────────────
/**
 * The `cases` scope orders candidates by `updated_at ASC`, so the creation order below IS the
 * item order. The sleeps are not politeness: two cases created inside the same millisecond share
 * an `updated_at`, and SQLite's ordering between them is then unspecified — which would make
 * "item B is the broken one" a coin flip. Cheap insurance against a gate that fails for the
 * wrong reason.
 *
 * A is created above by `confirmHome`, so only B-D are created here.
 */
for (const slug of [B, C, D]) {
  await sleep(1100)
  await main.evalJs(
    `window.argus.cases.create({ slug: ${JSON.stringify(slug)}, title: 'Gate item ${slug.slice(-1).toUpperCase()}' })`
  )
}
const seeded = (await caseList()).map((c) => c.slug).sort()
check(
  'the four scope cases exist',
  CASES.every((s) => seeded.includes(s)) && seeded.length === CASES.length,
  seeded
)

// The failure injection. See the header: a regular file where the case directory belongs makes
// `materializeSessionSkills`' mkdir throw, which lands in the per-item catch.
const brokenDir = path.join(HOME, 'cases', B)
fs.rmSync(brokenDir, { recursive: true, force: true })
fs.writeFileSync(brokenDir, 'this is a file, not a directory — the item gate breaks B on purpose')
check(
  'item B is deliberately broken on disk while its row stays intact',
  fs.statSync(brokenDir).isFile() && (await caseBySlug(B)) !== null
)

// ── 2. the scoped routine ───────────────────────────────────────────────────────────────────
/**
 * `status: ['open']` rather than a tag filter, because nothing in the product's IPC surface can
 * put a tag on a case before a routine has run (tags arrive by ACCEPTING a suggestion, which is
 * itself one of the things under test). On a home this gate has already proven is fresh, "every
 * open case" is exactly the four seeded above.
 *
 * The prompt is deliberately tiny and mechanical. This gate is checking the LOOP, not the
 * model's judgement: a prompt that asks for real analysis would make the suggestion's content
 * unpredictable, and asserting on it would then be a test of the model rather than of the
 * accept path that applies it.
 */
const routineDef = {
  id: ROUTINE,
  name: 'Item gate',
  prompt:
    `Do not read or write any files, and do not run any commands. Call propose_case_triage ` +
    `exactly once, with title exactly "${SUGGESTED_TITLE}", tags exactly ` +
    `${JSON.stringify(SUGGESTED_TAGS)}, and a one-sentence rationale. Then reply with the ` +
    `single word: done.`,
  timeoutMs: 300_000,
  enabled: true,
  scope: { kind: 'cases', status: ['open'] },
  maxItemsPerRun: 3
}
const saved = await main.evalJs(`window.argus.routines.save(${JSON.stringify(routineDef)})`)
const savedDef = saved.routines.find((r) => r.id === ROUTINE)
check('the scoped routine round-trips through config/routines.json', !!savedDef, savedDef?.id)
check(
  'the saved routine kept its scope and cap (a silent strip is invisible on screen)',
  savedDef?.scope?.kind === 'cases' && savedDef?.maxItemsPerRun === 3,
  [savedDef?.scope, savedDef?.maxItemsPerRun]
)

/** Wait for `runNow` to have produced `n` finished runs of `routineId`, and return them. */
const runsOf = async (routineId) => (await payload()).runs.filter((r) => r.routineId === routineId)
const awaitRuns = async (routineId, n, label) => {
  await waitFor(
    label,
    async () => {
      const rs = await runsOf(routineId)
      return rs.length >= n && rs.every((r) => r.status !== 'running')
    },
    RUN_TIMEOUT_MS
  )
  return runsOf(routineId)
}
const itemsOf = async (runId) => (await payload()).runItems.filter((i) => i.runId === runId)

// ── 3. run 1: the item loop, the cap, and one failure that does not block the rest ──────────
await main.evalJs(`window.argus.routines.runNow(${JSON.stringify(ROUTINE)})`)
const afterRun1 = await awaitRuns(ROUTINE, 1, 'the first scoped run to finish')
check('run 1 exists', afterRun1.length === 1, afterRun1.length)
const run1 = afterRun1[0]

const items1 = await itemsOf(run1.id)
check(
  'run 1 opened exactly one item row per capped candidate',
  items1.length === 3,
  items1.map((i) => [i.itemKey, i.status])
)
check(
  'the items are the three oldest candidates, in order — D is over the cap',
  JSON.stringify(items1.map((i) => i.itemKey)) === JSON.stringify([A, B, C]),
  items1.map((i) => i.itemKey)
)
const byKey = Object.fromEntries(items1.map((i) => [i.itemKey, i]))
check('item A processed', byKey[A]?.status === 'processed', [byKey[A]?.status, byKey[A]?.error])
check(
  'the deliberately-broken item B is recorded failed, with a real error',
  byKey[B]?.status === 'failed' && !!byKey[B]?.error,
  byKey[B]?.error
)
check('item C — BEHIND the failure — still processed', byKey[C]?.status === 'processed', [
  byKey[C]?.status,
  byKey[C]?.error
])
check('a run with failures but some work done is still ok, not failed', run1.status === 'ok', [
  run1.status,
  run1.error
])
check(
  'run 1 reports the cap remainder rather than dropping it',
  /1 carried to the next run/.test(run1.summary ?? ''),
  run1.summary
)
check(
  'run 1 reports its per-item outcome counts',
  /2 processed/.test(run1.summary ?? '') && /1 failed/.test(run1.summary ?? ''),
  run1.summary
)
check(
  'a scoped run opens no `routine-<id>` case of its own',
  run1.caseSlug === null && (await caseBySlug(`routine-${ROUTINE}`)) === null,
  run1.caseSlug
)

// The item chain end to end: `runItemId` reached the session, `propose_case_triage` was
// advertised, the model called it, and the blob parsed back out over IPC.
check(
  'the processed items carry a real triage suggestion (the runItemId chain is live)',
  byKey[A]?.suggestion?.title === SUGGESTED_TITLE &&
    JSON.stringify(byKey[A]?.suggestion?.tags) === JSON.stringify(SUGGESTED_TAGS),
  byKey[A]?.suggestion
)
check(
  'a suggestion is bound to its OWN item, not shared across the run',
  byKey[C]?.suggestion?.title === SUGGESTED_TITLE && byKey[B]?.suggestion === null,
  [byKey[C]?.suggestion?.title, byKey[B]?.suggestion]
)

// Drafts.
check(
  'each processed item leaves its case in review_state draft',
  (await caseBySlug(A))?.reviewState === 'draft' && (await caseBySlug(C))?.reviewState === 'draft',
  [(await caseBySlug(A))?.reviewState, (await caseBySlug(C))?.reviewState]
)
check(
  'a FAILED item leaves no draft behind — there is nothing to review',
  (await caseBySlug(B))?.reviewState === null,
  (await caseBySlug(B))?.reviewState
)
check(
  'an item never reached under the cap is untouched',
  (await caseBySlug(D))?.reviewState === null,
  (await caseBySlug(D))?.reviewState
)

// ── 4. Home: the inbox, its item rows, and the Draft badge ──────────────────────────────────
/**
 * NAVIGATE, THEN PROVE YOU ARRIVED. The inbox and the case grid render only inside
 * `CaseDashboard`, and the active view is persisted across reloads — so a gate that starts
 * wherever the app happens to be will cheerfully report "Home shows no inbox" from the Settings
 * page. That is exactly what increment 3's first draft did. The wordmark is Home's affordance.
 */
const INBOX = `document.querySelector('[data-testid="routine-inbox"]')`
const inboxText = () =>
  main.evalJs(`(() => { const e = ${INBOX}; return e ? e.innerText : null })()`)

const toHome = async (what) => {
  await main.evalJs(
    `(() => { const b = document.querySelector('[aria-label="All cases"]'); if (b) b.click(); return !!b })()`
  )
  await waitFor(
    'Home to be on screen',
    async () =>
      await main.evalJs(
        `!!document.querySelector('h1') && document.querySelectorAll('[data-testid="case-title"]').length > 0`
      ),
    30000
  )
  check(
    `the gate is on Home before asserting about ${what}`,
    await main.evalJs(
      `!!document.querySelector('h1') && document.querySelectorAll('[data-testid="case-title"]').length > 0`
    )
  )
}
await toHome('the inbox')

const text1 = await inboxText()
check('a finished scoped run puts an inbox on Home', text1 !== null)
check('the inbox names the routine', /Item gate/.test(text1 ?? ''), text1?.slice(0, 160))
// Case-INSENSITIVE throughout: every chip in this UI is uppercased in CSS and `innerText`
// reports the RENDERED casing, so /processed/ against a chip reading "PROCESSED" would fail for
// a reason that has nothing to do with the feature.
check(
  'the inbox shows one row per item, with its verb',
  new RegExp(A).test(text1 ?? '') &&
    new RegExp(B).test(text1 ?? '') &&
    new RegExp(C).test(text1 ?? '') &&
    /processed/i.test(text1 ?? '') &&
    /failed/i.test(text1 ?? ''),
  text1?.slice(0, 600)
)
check(
  'the failed row shows its reason rather than an empty line',
  (text1 ?? '').includes((byKey[B]?.error ?? '§none§').slice(0, 24)),
  byKey[B]?.error
)
check(
  'a scoped run offers no run-level Open case button (it has no case to open)',
  !(await main.evalJs(
    `[...${INBOX}.querySelectorAll('button')].some(b => /^Open case · Item gate/.test(b.getAttribute('aria-label') || ''))`
  ))
)
const verbs = await main.evalJs(
  `[...${INBOX}.querySelectorAll('button')].map(b => b.getAttribute('aria-label')).filter(Boolean)`
)
check(
  'the processed items offer Accept and Dismiss, keyed per item and run',
  verbs.includes(`Accept · ${A} · run ${run1.id}`) &&
    verbs.includes(`Dismiss · ${A} · run ${run1.id}`) &&
    verbs.includes(`Accept · ${C} · run ${run1.id}`),
  verbs
)
check(
  'the FAILED item offers no verbs — there is nothing to accept',
  !verbs.some((v) => v.startsWith(`Accept · ${B}`)) &&
    !verbs.some((v) => v.startsWith(`Dismiss · ${B}`)),
  verbs.filter((v) => v.includes(B))
)

/**
 * The rendered text of the grid card for `slug`, or null if there is no such card.
 *
 * KEYED ON THE SLUG, and returning null distinguishably, both learned from this gate's own first
 * run. The first draft walked up from the case TITLE node looking for an `action-items` ancestor
 * — which is not a card, it is a conditional row INSIDE one. When no card on the page had that
 * row (the exact situation defect 2 below produces), the walk ran off the top of the document and
 * returned null, and the negative assertion "a non-draft case shows no Draft badge" then passed
 * because there was no card at all. A vacuous pass, in the gate written to avoid vacuous passes.
 *
 * The slug is also the only stable key here: Accept REWRITES the title, so a title-keyed lookup
 * silently stops finding the card at exactly the moment the gate asserts the badge cleared.
 * Every caller below asserts the card was found before asserting anything about its contents.
 */
const cardOf = (slug) => `(() => {
  const card = [...document.querySelectorAll('.case-card')]
    .find((e) => (e.innerText || '').split('\\n')[0].trim() === ${JSON.stringify(slug)})
  return card ? card.innerText : null
})()`
const cardA1 = await main.evalJs(cardOf(A))
const cardD1 = await main.evalJs(cardOf(D))
check('both scope cases have a card in the grid to assert about', !!cardA1 && !!cardD1, [
  cardA1,
  cardD1
])
check('the draft case shows the Draft badge in the grid', /draft/i.test(cardA1 ?? ''), cardA1)
check('a case that is not a draft shows no Draft badge', !!cardD1 && !/draft/i.test(cardD1), cardD1)

// ── 5. run 2: carry-over, and nothing redone ────────────────────────────────────────────────
await main.evalJs(`window.argus.routines.runNow(${JSON.stringify(ROUTINE)})`)
const afterRun2 = await awaitRuns(ROUTINE, 2, 'the second scoped run to finish')
check('run 2 exists', afterRun2.length === 2, afterRun2.length)
const run2 = afterRun2.find((r) => r.id !== run1.id)
const items2 = await itemsOf(run2.id)
check(
  'run 2 picks up exactly the item run 1 capped off',
  items2.length === 1 && items2[0].itemKey === D,
  items2.map((i) => [i.itemKey, i.status])
)
check('the carried-over item processed', items2[0]?.status === 'processed', items2[0]?.error)
check(
  'run 2 redoes NONE of run 1 items — not the processed ones, not the failed one',
  !items2.some((i) => i.itemKey === A || i.itemKey === B || i.itemKey === C),
  items2.map((i) => i.itemKey)
)
check(
  'run 1 item rows are not rewritten by run 2',
  (await itemsOf(run1.id)).length === 3,
  (await itemsOf(run1.id)).length
)
skip(
  'the next run starts PAST a failed item because the cursor advanced over it',
  'cursor-specific, and a `cases` scope has no cursor at all (ItemTarget.cursorValue is null ' +
    'by construction — items.ts explains why a cursor would be actively wrong for a sweep). ' +
    'The equivalent property IS asserted above, through the other mechanism a `cases` scope ' +
    "uses: selectCaseItems drops a candidate whose updatedAt is not newer than this routine's " +
    'lastAttemptAt, which is why run 2 does not re-attempt the failed item B. The CURSOR half ' +
    'of this rule is only reachable through a jira-jql scope, which is skipped below.'
)

// ── 6. Accept and Dismiss, through the real buttons ─────────────────────────────────────────
await toHome('accept and dismiss')
const before = await caseBySlug(A)
check(
  'before accepting, the case still carries its own title and no tags',
  before?.title === 'Gate item A' && before?.tags.length === 0,
  [before?.title, before?.tags]
)
const clickedAccept = await main.evalJs(`(() => {
  const b = [...${INBOX}.querySelectorAll('button')]
    .find(x => x.getAttribute('aria-label') === ${JSON.stringify(`Accept · ${A} · run ${run1.id}`)})
  if (!b) return false
  b.click()
  return true
})()`)
check('the inbox row offers an Accept button that clicks', clickedAccept)
await waitFor(
  'the accepted case to leave draft',
  async () => (await caseBySlug(A))?.reviewState === null,
  20000
)
const acceptedCase = await caseBySlug(A)
check(
  'Accept applies the suggested title',
  acceptedCase?.title === SUGGESTED_TITLE,
  acceptedCase?.title
)
check(
  'Accept applies the suggested tags',
  SUGGESTED_TAGS.every((t) => acceptedCase?.tags.includes(t)),
  acceptedCase?.tags
)
check('Accept clears the draft flag', acceptedCase?.reviewState === null, acceptedCase?.reviewState)
// The mirror, not just the row: `setCaseTriage` writes both, and only one of them is what the
// rest of the app reads back off disk.
const mirrored = JSON.parse(fs.readFileSync(path.join(HOME, 'cases', A, 'case.json'), 'utf8'))
check(
  'Accept mirrors the applied title into case.json, not just the database row',
  mirrored.title === SUGGESTED_TITLE,
  mirrored.title
)
await toHome('the cleared Draft badge')
// Looked up by SLUG: Accept rewrites the title, so a title-keyed lookup would find nothing here
// and "no Draft badge" would pass on an absent card rather than on a cleared one.
const cardA2 = await main.evalJs(cardOf(A))
check('the accepted case still has a card in the grid', !!cardA2, cardA2)
check(
  'the Draft badge clears from the accepted case card',
  !!cardA2 && !/draft/i.test(cardA2),
  cardA2
)

// Dismiss is a MenuButton: open it, then pick the resolution.
const RESOLUTION = 'wont-fix'
const openedMenu = await main.evalJs(`(() => {
  const b = [...${INBOX}.querySelectorAll('button')]
    .find(x => x.getAttribute('aria-label') === ${JSON.stringify(`Dismiss · ${C} · run ${run1.id}`)})
  if (!b) return false
  b.click()
  return true
})()`)
check('the inbox row offers a Dismiss menu that opens', openedMenu)
await sleep(400)
const pickedResolution = await main.evalJs(`(() => {
  const el = [...document.querySelectorAll('button,[role="menuitem"]')]
    .find(x => (x.textContent || '').trim() === ${JSON.stringify(RESOLUTION)})
  if (!el) return false
  el.click()
  return true
})()`)
check('the Dismiss menu lists the case resolutions', pickedResolution)
await waitFor(
  'the dismissed case to close',
  async () => (await caseBySlug(C))?.status === 'closed',
  20000
)
const dismissed = await caseBySlug(C)
check(
  'Dismiss closes the case with the resolution that was chosen',
  dismissed?.status === 'closed' && dismissed?.resolution === RESOLUTION,
  [dismissed?.status, dismissed?.resolution]
)
check(
  'a dismissed draft stays distinguishable from a case that was never one',
  dismissed?.reviewState === 'draft',
  dismissed?.reviewState
)

// ── 7. the unscoped regression guard (increments 1-3) ───────────────────────────────────────
/**
 * THE POINT OF THIS SECTION is that increment 5 must not have changed what a routine WITHOUT a
 * scope does. Three shipped increments were live-verified against that shape: one turn, one
 * `routine-<id>` case reused across runs, an `origin` stamp, and NO item rows at all. `execute`
 * branches on `routine.scope` before anything else runs precisely so this path stays
 * byte-for-byte what it was; nothing but a live run can confirm it did.
 */
await main.evalJs(
  `window.argus.routines.save(${JSON.stringify({
    id: UNSCOPED,
    name: 'Unscoped gate',
    prompt: 'Reply with the single word: done. Do not use any tools.',
    timeoutMs: 300_000,
    enabled: true
  })})`
)
await main.evalJs(`window.argus.routines.runNow(${JSON.stringify(UNSCOPED)})`)
const un1 = await awaitRuns(UNSCOPED, 1, 'the first unscoped run to finish')
check('the unscoped run finished ok', un1[0]?.status === 'ok', [un1[0]?.status, un1[0]?.error])
check(
  'an unscoped run opens NO item rows',
  (await itemsOf(un1[0].id)).length === 0,
  await itemsOf(un1[0].id)
)
check(
  'an unscoped run records its own routine-<id> case',
  un1[0]?.caseSlug === `routine-${UNSCOPED}`,
  un1[0]?.caseSlug
)
const routineCase = await caseBySlug(`routine-${UNSCOPED}`)
check(
  'the routine case is stamped routine-origin',
  routineCase?.origin === 'routine',
  routineCase?.origin
)
check(
  'the routine case is NOT a draft — drafts are an item-loop concept',
  routineCase?.reviewState === null,
  routineCase?.reviewState
)

await main.evalJs(`window.argus.routines.runNow(${JSON.stringify(UNSCOPED)})`)
const un2 = await awaitRuns(UNSCOPED, 2, 'the second unscoped run to finish')
check(
  'the second unscoped run finished ok',
  un2.every((r) => r.status === 'ok'),
  un2.map((r) => r.status)
)
check(
  'both unscoped runs REUSE the one routine-<id> case',
  un2.every((r) => r.caseSlug === `routine-${UNSCOPED}`) &&
    (await caseList()).filter((c) => c.slug === `routine-${UNSCOPED}`).length === 1,
  un2.map((r) => r.caseSlug)
)
check(
  'the second unscoped run still opens no item rows',
  (await itemsOf(un2.find((r) => r.id !== un1[0].id).id)).length === 0
)

await toHome('the mixed inbox')
const mixed = await inboxText()
check(
  'the unscoped run renders beside the scoped ones, with its own Open case',
  /Unscoped gate/.test(mixed ?? '') &&
    (await main.evalJs(
      `[...${INBOX}.querySelectorAll('button')].some(b => /^Open case · Unscoped gate/.test(b.getAttribute('aria-label') || ''))`
    )),
  mixed?.slice(0, 400)
)

// ── 8. what this environment cannot check ───────────────────────────────────────────────────
skip(
  'a jira-jql scope resolves a real JQL: endpoint shape, adopt-vs-create, and the ISO->JQL date',
  'no Atlassian credentials are configured in this environment, so no live Jira call can be ' +
    'made at all. This is the single largest outstanding risk on the branch: ' +
    'AtlassianClient.searchIssues targets /rest/api/3/search/jql and reads nextPageToken and ' +
    'fields.created, all three DOCUMENTED BUT UNVERIFIED (task 6 carried the risk forward ' +
    'explicitly). If the shape is wrong, searchIssues is where it breaks — and nothing above ' +
    "touches it, because a `cases` scope never calls the resolver's jql half. Re-run this " +
    'gate with a jira-jql routine against a real project before shipping.'
)
skip(
  'search_known_defects returns real corpus hits inside a routine turn',
  'no defect-corpus source is configured in this environment. The pre-fix behaviour is a ' +
    'PLAUSIBLE STRING ("no sources configured"), not an error, so an assertion that merely ' +
    'checks the tool was reachable would pass either way — which is why this is skipped rather ' +
    'than weakened. Task 8 proved the corpus reaches the unattended session deps; what is ' +
    'unproven live is that a configured corpus returns hits to a routine turn.'
)

report()
