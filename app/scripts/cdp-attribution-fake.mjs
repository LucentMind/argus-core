#!/usr/bin/env node
/**
 * Deterministic attribution gate — drives the REAL app over CDP with the headless runners
 * replaced by the fixture-driven fake (src/main/services/distill/fakeRunner.ts), so it costs
 * nothing, needs no login and can run in CI.
 *
 * The paid gate `cdp-attribution.mjs` is the model: same settings merge, same identity gate,
 * same settle, same Observability / Library / runs-view navigation. What differs is where the
 * scenarios come from — every fixture under scripts/fixtures/distill/ (scripts/lib/fixtures.mjs
 * loads, seeds and compares them; the README there documents the schema) — and that the gate
 * boots the app itself.
 *
 * Per fixture, sequentially (the distill queue is global and runs one job at a time):
 *   setPipeline → seed the transcript into <home>/argus.db → write the fake's
 *   <fakeDir>/<slug>.json → close (or redistill) through the preload → settle → actions
 *   (retract / reject) → compare the DB with `expected` (checkExpected) → assert `expected.ui`
 *   through the app's own controls. UI assertions run right after each fixture's DB check: the
 *   Library and Observability aggregate across cases, and the asset names are unique per fixture.
 *
 * Every fixture's assets are written to disk ONCE, before the Library is first opened (before
 * boot in self-boot mode): the renderer mirrors the reference list on the Library's first mount
 * and refreshes it only on a refsync:changed broadcast, which a file written behind the app's
 * back never triggers — a reference written per fixture is missing from the Library. Asset
 * names are unique across fixtures and the chip/card only reflect attribution rows, so the
 * extra rows are inert for every other fixture.
 *
 * Boot (default): a scratch home at <os.tmpdir()>/argus-fake-<pid>/home, a free port in
 * 9260-9290, and
 *   npx electron-vite dev -- --remote-debugging-port=<port>
 * from app/ with ARGUS_HOME, ARGUS_HEADLESS_FAKE=<home>/fake-runner, ARGUS_DEV_TOOLS=1. Port
 * flag: verified empirically on electron-vite 5.0.0 (2026-10-21) — `-- --remote-debugging-port=N`
 * (forwarded through ELECTRON_CLI_ARGS) and `--remoteDebuggingPort N` (REMOTE_DEBUGGING_PORT)
 * both bind N; this gate uses the first. The gate waits for /json/version, then for the boot
 * log's `[distill] FAKE RUNNER active: <its own fake dir>`, and aborts (exit 2) if the child log
 * shows the port was taken (`bind() returned an error` / `Cannot start http server`) — that is
 * how a gate ends up driving another worktree's app. Teardown kills only the spawned tree
 * (taskkill /T /F on Windows, the process group elsewhere) and deletes the scratch dir on
 * success; on failure the dir is kept and its path printed.
 *
 * Attach mode: CDP_PORT=<port> ARGUS_HOME=<home> node scripts/cdp-attribution-fake.mjs drives an
 * app you booted yourself with ARGUS_HEADLESS_FAKE=<home>/fake-runner and dev tools on. It must
 * be a FRESH home: a fixture case that already has sessions is refused (exit 1) rather than
 * re-checked against stale state.
 *
 * Exits 0 when every check passes, 1 when any fails, 2 on an abort (boot / port / identity /
 * settings / fake runner not active).
 */
import { DatabaseSync } from 'node:sqlite'
import { spawn, execSync } from 'node:child_process'
import fs from 'node:fs'
import net from 'node:net'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { listTargets, connect, mainWindow, sleep, waitFor, check, report } from './lib/cdp.mjs'
import {
  listFixtures,
  writeFixtureAssets,
  seedFixtureCase,
  resolveStages,
  writeFakeStages,
  readFakeCalls,
  readActual,
  checkExpected
} from './lib/fixtures.mjs'

const APP_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const WIN = process.platform === 'win32'
const ATTACH = Boolean(process.env.CDP_PORT && process.env.ARGUS_HOME)
const ROOT = ATTACH ? null : path.join(os.tmpdir(), `argus-fake-${process.pid}`)
const HOME = ATTACH ? path.resolve(process.env.ARGUS_HOME) : path.join(ROOT, 'home')
const FAKE_DIR = path.join(HOME, 'fake-runner')
const DB = path.join(HOME, 'argus.db')
const LOG = ROOT ? path.join(ROOT, 'electron.log') : null
const BOOT_TIMEOUT_MS = 120_000
const SETTLE_TIMEOUT_MS = 90_000
const UI_TIMEOUT_MS = 15_000
const PORT_COLLISION = /bind\(\) returned an error|Cannot start http server/

// ---------- boot + teardown ----------
let child = null
let childLog = ''
let childExited = null

/** Abort (exit 2). The tail of the child's boot log goes to stderr too, so a CI failure is
 *  diagnosable from the job output alone (the kept electron.log is not an artifact there). */
const abort = (msg) => {
  console.error(msg)
  if (childLog)
    console.error(
      `--- last 40 lines of the app's boot log (${LOG}) ---\n${childLog.trimEnd().split(/\r?\n/).slice(-40).join('\n')}`
    )
  process.exit(2)
}

/** Abort when the child's log shows the port was taken or the child died. A no-op in attach
 *  mode (no child, no log). Runs during boot and once more right before the first write. */
function logGuard(port) {
  if (PORT_COLLISION.test(childLog))
    abort(`PORT FAIL: port ${port} was taken (child log: bind error); refusing to drive it`)
  if (childExited !== null)
    abort(`BOOT FAIL: electron-vite exited (${childExited}) before the app was ready`)
}

function killChild() {
  if (!child || childExited !== null) return
  try {
    if (WIN) execSync(`taskkill /PID ${child.pid} /T /F`, { stdio: 'ignore' })
    else process.kill(-child.pid, 'SIGKILL')
  } catch {
    /* already gone */
  }
  child = null
}

process.on('exit', (code) => {
  killChild()
  if (!ROOT) return
  if (code === 0) {
    try {
      fs.rmSync(ROOT, { recursive: true, force: true, maxRetries: 10, retryDelay: 300 })
    } catch (e) {
      console.error(`scratch dir not removed (${e.message}): ${ROOT}`)
    }
  } else {
    console.error(`scratch dir kept for inspection: ${ROOT}`)
  }
})
for (const sig of ['SIGINT', 'SIGTERM']) process.on(sig, () => process.exit(130))

/** First port in [lo, hi] that nothing listens on: it must refuse CDP AND accept a bind. */
async function freePort(lo, hi) {
  for (let p = lo; p <= hi; p++) {
    const cdp = await fetch(`http://127.0.0.1:${p}/json/version`, {
      signal: AbortSignal.timeout(1000)
    })
      .then(() => true)
      .catch(() => false)
    if (cdp) continue
    const bindable = await new Promise((res) => {
      const srv = net.createServer()
      srv.once('error', () => res(false))
      srv.listen(p, '127.0.0.1', () => srv.close(() => res(true)))
    })
    if (bindable) return String(p)
  }
  abort(`BOOT FAIL: no free port in ${lo}-${hi}`)
}

const samePath = (a, b) => {
  const n = (p) => path.resolve(p).replace(/[\\/]+$/, '')
  return WIN ? n(a).toLowerCase() === n(b).toLowerCase() : n(a) === n(b)
}

async function boot(port) {
  const args = ['electron-vite', 'dev', '--', `--remote-debugging-port=${port}`]
  fs.writeFileSync(LOG, '')
  // Ambient ARGUS_* (a shell left over from another worktree's session) and CDP_PORT must not
  // reach the app: only the gate's own values below.
  const env = Object.fromEntries(
    Object.entries(process.env).filter(([k]) => !/^ARGUS_/.test(k) && k !== 'CDP_PORT')
  )
  Object.assign(env, {
    ARGUS_HOME: HOME,
    ARGUS_HEADLESS_FAKE: FAKE_DIR,
    ARGUS_DEV_TOOLS: '1',
    ELECTRON_DISABLE_SECURITY_WARNINGS: '1'
  })
  child = spawn(WIN ? 'npx.cmd' : 'npx', args, {
    cwd: APP_DIR,
    env,
    stdio: ['ignore', 'pipe', 'pipe'],
    shell: WIN,
    detached: !WIN
  })
  // Synchronous append per chunk (the log is small): nothing is left buffered when abort()
  // calls process.exit, so the kept electron.log never loses its tail.
  const tee = (d) => {
    childLog += d.toString()
    fs.appendFileSync(LOG, d)
  }
  child.stdout.on('data', tee)
  child.stderr.on('data', tee)
  child.on('exit', (code) => {
    childExited = code ?? -1
  })
  console.error(`booting: npx ${args.join(' ')} (home ${HOME}, log ${LOG})`)
  const guard = () => logGuard(port)
  await waitFor(
    `CDP endpoint on ${port}`,
    async () => {
      guard()
      return fetch(`http://127.0.0.1:${port}/json/version`, { signal: AbortSignal.timeout(1000) })
        .then((r) => r.ok)
        .catch(() => false)
    },
    BOOT_TIMEOUT_MS
  ).catch(() => abort(`BOOT FAIL: no CDP endpoint on ${port} within ${BOOT_TIMEOUT_MS / 1000}s`))
  const fakeLine = await waitFor(
    'FAKE RUNNER active in the boot log',
    () => {
      guard()
      return /\[distill\] FAKE RUNNER active: (.+)/.exec(childLog)?.[1].trim() ?? null
    },
    60_000
  ).catch(() => abort('BOOT FAIL: the boot log never said `[distill] FAKE RUNNER active`'))
  if (!samePath(fakeLine, FAKE_DIR))
    abort(`BOOT FAIL: the fake runner reads ${fakeLine}, not this gate's ${FAKE_DIR}`)
  guard()
}

// ---------- settings ----------
/** Merge `distill.pipeline` + `distill.attribution.default = true` into the home's settings
 *  file (cdp-attribution.mjs forceSettings): clobbering a valid file would reset the rest. */
function forceSettings(pipeline) {
  const file = path.join(HOME, 'config', 'settings.json')
  let cur = {}
  try {
    cur = JSON.parse(fs.readFileSync(file, 'utf8'))
  } catch {
    /* absent or unparseable */
  }
  const distill = cur.distill ?? {}
  const next = {
    ...cur,
    distill: {
      ...distill,
      pipeline,
      attribution: { ...(distill.attribution ?? {}), default: true }
    }
  }
  fs.mkdirSync(path.dirname(file), { recursive: true })
  fs.writeFileSync(file, JSON.stringify(next, null, 2))
}

const reportsPipeline = (conn, pipeline) =>
  waitFor(
    `app reports distill.pipeline=${pipeline} and attribution.default=true`,
    async () => {
      const d = (await conn.evalJs(`window.argus.settings.get()`))?.settings?.distill
      return d?.pipeline === pipeline && d?.attribution?.default === true ? d : null
    },
    20_000
  ).catch(() => null)

// ---------- DB ----------
const withDb = (fn) => {
  const db = new DatabaseSync(DB)
  try {
    return fn(db)
  } finally {
    db.close()
  }
}
const jobsFor = (slug) =>
  withDb((db) =>
    db.prepare(`SELECT id, kind, state FROM distill_jobs WHERE case_slug=? ORDER BY id`).all(slug)
  )
const isTerminal = (j) => j.state === 'done' || j.state === 'failed' || j.state === 'cancelled'

/** Paid gate's settle on a fake-sized budget: >= 1 job (when expected), all terminal, then a
 *  short window so an escape-hatch enqueue triggered by the last job's finish has landed. */
async function settle(slug, expectJob) {
  const t0 = Date.now()
  const left = () => Math.max(1000, SETTLE_TIMEOUT_MS - (Date.now() - t0))
  if (expectJob) await waitFor(`a job for ${slug}`, () => jobsFor(slug).length > 0, left())
  await waitFor(
    `${slug} jobs terminal`,
    () => {
      const js = jobsFor(slug)
      return js.every(isTerminal) && (!expectJob || js.length > 0)
    },
    left()
  )
  await sleep(3000)
  await waitFor(
    `${slug} jobs terminal (after settle)`,
    () => jobsFor(slug).every(isTerminal),
    left()
  )
  console.error(`${slug}: terminal after ${((Date.now() - t0) / 1000).toFixed(1)}s`)
}

// ---------- UI helpers ----------
const clickByLabel = (conn, label) =>
  conn.evalJs(`(() => {
    const el = [...document.querySelectorAll('[aria-label]')].find((e) => e.getAttribute('aria-label') === ${JSON.stringify(label)})
    if (!el) return false
    el.click()
    return true
  })()`)
const clickButtonText = (conn, text) =>
  conn.evalJs(`(() => {
    const el = [...document.querySelectorAll('button')].find((b) => (b.textContent || '').trim() === ${JSON.stringify(text)})
    if (!el) return false
    el.click()
    return true
  })()`)
/** The Settings gear's accessible name grows a "needs you" count, so match it by title. */
const clickSettingsGear = (conn) =>
  conn.evalJs(`(() => {
    const el = document.querySelector('button[title="Settings"]')
    if (!el) return false
    el.click()
    return true
  })()`)
const settingsNavShown = (conn) =>
  conn.evalJs(`Boolean(document.querySelector('nav[aria-label="Settings sections"]'))`)
const clickSettingsSection = (conn, name) =>
  conn.evalJs(`(() => {
    const nav = document.querySelector('nav[aria-label="Settings sections"]')
    const b = nav && [...nav.querySelectorAll('button')].find((x) => (x.textContent || '').trim() === ${JSON.stringify(name)})
    if (!b) return false
    b.click()
    return true
  })()`)
const onHome = (conn) =>
  conn.evalJs(
    `!document.querySelector('nav[aria-label="Settings sections"]') && !document.querySelector('[data-card-id="usefulness.assets"]') && ![...document.querySelectorAll('h1')].some((h) => (h.textContent || '').startsWith('Distillation runs'))`
  )
/** Every view toggles from home, so each UI read starts there (the wordmark button). */
async function goHome(conn) {
  await clickByLabel(conn, 'All cases')
  await waitFor('home view', () => onHome(conn), UI_TIMEOUT_MS)
}
async function openSettingsSection(conn, name) {
  await goHome(conn)
  await clickSettingsGear(conn)
  await waitFor('Settings sections nav', () => settingsNavShown(conn), UI_TIMEOUT_MS).catch(
    () => null
  )
  return clickSettingsSection(conn, name)
}

// ---------- assertUi ----------
const CHIP_RE = 'helped \\d+ · misled \\d+'

/** Library row by the label button SettingRow renders (`open · <name>`); its parent holds the
 *  label and that row's badges only. `usageLoaded` is the activation / read-count text that
 *  arrives in the SAME usage.stats() callback as the usefulness map, so a missing chip can be
 *  told apart from a chip that has not loaded yet. */
const libraryScan = (conn, asset) =>
  conn.evalJs(`(() => {
    const want = ${JSON.stringify(`open · ${asset}`)}
    const btn = [...document.querySelectorAll('button[aria-label]')].find((b) => b.getAttribute('aria-label') === want)
    if (!btn) return { rowFound: false, usageLoaded: false, chipText: null }
    const badges = btn.parentElement
    const row = btn.closest('[class~="group/row"]') || badges
    const m = (badges.textContent || '').match(new RegExp(${JSON.stringify(CHIP_RE)}, 'g'))
    const usageLoaded = /never activated|\\d+× · last|never read|\\d+ reads · last/.test(row.textContent || '')
    return { rowFound: true, usageLoaded, chipText: m ? m.join(' | ') : null }
  })()`)

async function assertLibrary(conn, fx) {
  const { asset, text } = fx.expected.ui.libraryChip
  const ok = await openSettingsSection(conn, 'Library')
  check(`${fx.slug}: UI Settings has a Library page`, ok)
  let lib = { rowFound: false, usageLoaded: false, chipText: null }
  await waitFor(
    `Library row for ${asset}`,
    async () => {
      lib = (await libraryScan(conn, asset)) ?? lib
      return lib.rowFound && lib.usageLoaded && (text === null || lib.chipText === text)
    },
    UI_TIMEOUT_MS
  ).catch(() => null)
  check(
    `${fx.slug}: UI Library shows a row for ${asset} (usage loaded)`,
    lib.rowFound && lib.usageLoaded,
    lib
  )
  if (text === null)
    check(
      `${fx.slug}: UI Library row for ${asset} has NO usefulness chip`,
      lib.rowFound && lib.usageLoaded && lib.chipText === null,
      lib.chipText
    )
  else
    check(
      `${fx.slug}: UI Library row for ${asset} chip reads "${text}"`,
      lib.chipText === text,
      lib.chipText
    )
}

const cardNames = (conn) =>
  conn.evalJs(`(() => {
    const card = document.querySelector('[data-card-id="usefulness.assets"]')
    if (!card) return null
    return [...card.querySelectorAll('tbody tr')].map((tr) => (tr.querySelector('td')?.textContent || '').trim())
  })()`)

async function assertObservability(conn, fx) {
  const { observabilityLists: lists, observabilityOmits: omits } = fx.expected.ui
  const ok = await openSettingsSection(conn, 'Observability')
  check(`${fx.slug}: UI Settings has an Observability page`, ok)
  const dash = await waitFor(
    'Open dashboard button',
    () => clickButtonText(conn, 'Open dashboard'),
    UI_TIMEOUT_MS
  ).catch(() => false)
  check(`${fx.slug}: UI Observability has an Open dashboard button`, dash)
  // The card renders only once usage.stats() returned rows; wait for it and for every listed
  // name (on timeout keep the last read).
  let names = null
  await waitFor(
    'Knowledge usefulness card',
    async () => {
      names = (await cardNames(conn)) ?? names
      return names && lists.every((n) => names.includes(n))
    },
    20_000
  ).catch(() => null)
  if (names === null) {
    // No card: legitimate only when there is nothing to show at all.
    const rows = (await conn.evalJs(`window.argus.usage.stats()`))?.usefulness ?? []
    check(
      `${fx.slug}: UI Knowledge usefulness card shown (or no usefulness rows at all)`,
      lists.length === 0 && rows.length === 0,
      { usefulnessRows: rows.length }
    )
  } else {
    check(`${fx.slug}: UI Knowledge usefulness card shown`, true, `${names.length} rows`)
  }
  for (const n of lists)
    check(`${fx.slug}: UI usefulness card lists ${n}`, Boolean(names?.includes(n)), names)
  for (const n of omits)
    check(`${fx.slug}: UI usefulness card omits ${n}`, !(names ?? []).includes(n), names)
}

/** Open the runs view from home; wait for the fixture's row (`#<id> ·`) to be rendered. */
async function openRunsAt(conn, jobId) {
  await goHome(conn)
  const opened = await clickByLabel(conn, 'Distillation runs')
  if (!opened) return { opened, row: null }
  await waitFor(
    'runs view',
    () =>
      conn.evalJs(
        `[...document.querySelectorAll('h1')].some((h) => (h.textContent || '').startsWith('Distillation runs'))`
      ),
    UI_TIMEOUT_MS
  ).catch(() => null)
  await clickByLabel(conn, 'Show runs') // a collapsed rail (persisted) hides the rows
  const row = await waitFor(
    `run row #${jobId}`,
    () =>
      conn.evalJs(`(() => {
        const r = [...document.querySelectorAll('[data-testid="run-row"]')].find((b) => (b.textContent || '').trim().startsWith(${JSON.stringify(`#${jobId} ·`)}))
        return r ? (r.textContent || '').trim() : null
      })()`),
    UI_TIMEOUT_MS
  ).catch(() => null)
  return { opened, row }
}

async function assertRunsRail(conn, fx, jobs) {
  const label = fx.expected.ui.runsRailLabel
  const att = jobs.find((j) => j.kind === 'attribution')
  if (!att) {
    check(`${fx.slug}: UI runs rail — the fixture has an attribution job to look up`, false, jobs)
    return
  }
  const { opened, row } = await openRunsAt(conn, att.id)
  check(`${fx.slug}: UI TopBar has the Distillation runs button`, opened)
  check(
    `${fx.slug}: UI runs rail row #${att.id} carries "${label}"`,
    Boolean(row) && row.includes(label),
    row
  )
}

async function assertRunDetail(conn, fx, jobs) {
  const want = fx.expected.ui.runDetailSkipped
  const job = jobs[0]
  const { opened, row } = await openRunsAt(conn, job.id)
  check(`${fx.slug}: UI runs rail shows row #${job.id}`, opened && Boolean(row), row)
  await conn.evalJs(`(() => {
    const r = [...document.querySelectorAll('[data-testid="run-row"]')].find((b) => (b.textContent || '').trim().startsWith(${JSON.stringify(`#${job.id} ·`)}))
    if (r) r.click()
    return Boolean(r)
  })()`)
  // The card's id carries the job id, so a detail still showing the previous selection
  // cannot satisfy the wait.
  const text = await waitFor(
    `attribution card of run #${job.id}`,
    () =>
      conn.evalJs(
        `document.getElementById(${JSON.stringify(`card-${job.id}-attribution`)})?.textContent || null`
      ),
    UI_TIMEOUT_MS
  ).catch(() => null)
  check(
    `${fx.slug}: UI run #${job.id} attribution card says "${want}"`,
    Boolean(text) && text.includes(want),
    text
  )
}

async function assertUi(conn, fx) {
  const ui = fx.expected.ui
  const jobs = jobsFor(fx.slug)
  if (ui.observabilityLists.length || ui.observabilityOmits.length)
    await assertObservability(conn, fx)
  if (ui.libraryChip) await assertLibrary(conn, fx)
  if (ui.runsRailLabel !== null) await assertRunsRail(conn, fx, jobs)
  if (ui.runDetailSkipped !== null) await assertRunDetail(conn, fx, jobs)
  await goHome(conn).catch(() => null)
}

// ---------- main ----------
const main = async () => {
  const fixtures = listFixtures()
  console.error(`${fixtures.length} fixtures: ${fixtures.map((f) => f.slug).join(', ')}`)

  if (ATTACH) {
    if (!fs.existsSync(FAKE_DIR))
      abort(
        `ATTACH FAIL: ${FAKE_DIR} does not exist — the app must be booted with ARGUS_HEADLESS_FAKE=${FAKE_DIR}`
      )
  } else {
    fs.rmSync(ROOT, { recursive: true, force: true }) // a stale dir from a reused pid
    fs.mkdirSync(FAKE_DIR, { recursive: true }) // the fake refuses a missing dir at boot
  }
  // Settings + assets go in before boot; in attach mode only after the re-seed refusal below,
  // so a used home is left untouched.
  const prepareHome = () => {
    forceSettings('v3')
    for (const fx of fixtures) writeFixtureAssets(HOME, fx)
  }
  if (!ATTACH) prepareHome()
  const PORT = ATTACH ? process.env.CDP_PORT : await freePort(9260, 9290)
  if (!ATTACH) await boot(PORT)

  const target = await waitFor(
    'main window target',
    async () => mainWindow(await listTargets(PORT).catch(() => [])) ?? null,
    BOOT_TIMEOUT_MS
  ).catch(() => abort(`BOOT FAIL: no main window target on ${PORT}`))
  const conn = await connect(target)
  await waitFor(
    'renderer ready (preload + top bar)',
    () =>
      conn
        .evalJs(
          `typeof window.argus?.cases?.list === 'function' && Boolean(document.querySelector('button[aria-label="All cases"]'))`
        )
        .catch(() => false),
    BOOT_TIMEOUT_MS
  ).catch(() => abort('BOOT FAIL: the renderer never exposed window.argus and the top bar'))
  console.error(`connected to ${PORT}: ${target.url}`)

  // Identity pre-check, BEFORE any write (argus-cdp-port-collision): a wrong CDP_PORT can be
  // another worktree's app, and creating the fixture cases there would pollute its real home.
  // The connected app and ARGUS_HOME/argus.db must hold exactly the same set of cases (both
  // empty for a fresh home; a foreign app with cases, or a different home, mismatches).
  logGuard(PORT) // a bind-error line can land after `FAKE RUNNER active`
  const existing = (await conn.evalJs(`window.argus.cases.list()`)) ?? []
  const appSlugs = existing.map((c) => c.slug).sort()
  const dbSlugs = fs.existsSync(DB)
    ? withDb((db) =>
        db
          .prepare(`SELECT slug FROM cases`)
          .all()
          .map((r) => r.slug)
          .sort()
      )
    : null
  if (dbSlugs === null)
    abort(`IDENTITY FAIL: ${DB} does not exist; the connected app is not using this ARGUS_HOME`)
  if (appSlugs.join('\n') !== dbSlugs.join('\n'))
    abort(
      `IDENTITY FAIL: port ${PORT} lists cases [${appSlugs.join(', ')}] but ${DB} holds [${dbSlugs.join(', ')}]; the connected app is not using this ARGUS_HOME`
    )

  // Cases are created through the app (DB row + case dir), unless they already exist.
  for (const fx of fixtures) {
    if (existing.some((c) => c.slug === fx.slug)) continue
    await conn.evalJs(
      `window.argus.cases.create(${JSON.stringify({ slug: fx.slug, title: fx.title, ...(fx.jiraKey ? { jiraKey: fx.jiraKey } : {}) })})`
    )
  }

  // Identity gate (argus-cdp-port-collision): the port must show OUR fixture cases AND each must
  // be a row in THIS home's DB, which is where every assertion below reads from.
  const cases = (await conn.evalJs(`window.argus.cases.list()`)) ?? []
  const missing = fixtures.filter((f) => !cases.some((c) => c.slug === f.slug))
  if (missing.length)
    abort(
      `IDENTITY FAIL: port ${PORT} does not show fixture case(s) ${missing.map((f) => f.slug).join(', ')}; refusing to continue`
    )
  if (!fs.existsSync(DB))
    abort(`IDENTITY FAIL: ${DB} does not exist; the connected app is not using this ARGUS_HOME`)
  const notInDb = withDb((db) =>
    fixtures.filter((f) => !db.prepare(`SELECT 1 FROM cases WHERE slug=?`).get(f.slug))
  )
  if (notInDb.length)
    abort(
      `IDENTITY FAIL: fixture case(s) ${notInDb.map((f) => f.slug).join(', ')} are not rows in ${DB}; the connected app is not using this ARGUS_HOME`
    )
  check(
    'identity: every fixture case visible on the connected app AND a row in ARGUS_HOME/argus.db',
    true
  )

  // Re-seed refusal, before anything is written: a home whose fixture cases already carry
  // sessions would compare stale state (attach mode against a used home).
  for (const fx of fixtures) {
    const caseId = withDb((db) =>
      Number(db.prepare(`SELECT id FROM cases WHERE slug=?`).get(fx.slug).id)
    )
    const seeded = withDb((db) =>
      Number(db.prepare(`SELECT COUNT(*) AS n FROM sessions WHERE case_id=?`).get(caseId).n)
    )
    if (seeded === 0) continue
    console.error(
      `${fx.slug}: already has ${seeded} session(s); refusing to seed twice (attach mode against a used home)\nREFUSING: ${HOME} already holds seeded fixture cases. This gate needs a fresh home — unset CDP_PORT/ARGUS_HOME to let it boot its own.`
    )
    process.exit(1)
  }

  if (ATTACH) prepareHome()

  // Settings gate: the file edit must have reached the app before anything is closed.
  if (!(await reportsPipeline(conn, 'v3')))
    abort('SETTINGS FAIL: the app does not report distill.pipeline=v3 + attribution.default=true')
  check('settings: app reports distill.pipeline=v3 and distill.attribution.default=true', true)

  let firstClose = true
  for (const fx of fixtures) {
    console.error(
      `\n--- ${fx.slug} (${fx.scenario.split(':')[0]}, pipeline ${fx.settings.pipeline}) ---`
    )
    forceSettings(fx.settings.pipeline)
    const s = await reportsPipeline(conn, fx.settings.pipeline)
    if (!s) abort(`SETTINGS FAIL: the app never reported distill.pipeline=${fx.settings.pipeline}`)
    check(`${fx.slug}: app reports distill.pipeline=${fx.settings.pipeline}`, true)

    const before = jobsFor(fx.slug)
    check(
      `${fx.slug}: no prior distill jobs`,
      before.length === 0,
      before.map((j) => j.kind)
    )

    const caseId = withDb((db) =>
      Number(db.prepare(`SELECT id FROM cases WHERE slug=?`).get(fx.slug).id)
    )
    const ids = withDb((db) => seedFixtureCase(db, caseId, fx))
    writeFakeStages(FAKE_DIR, fx.slug, resolveStages(fx, ids))

    if (fx.close)
      await conn.evalJs(
        `window.argus.cases.setStatus(${JSON.stringify(fx.slug)}, 'closed', ${JSON.stringify(fx.close.resolution)}, ${fx.close.distill}, ${fx.close.attribution})`
      )
    else await conn.evalJs(`window.argus.distill.redistill(${JSON.stringify(fx.slug)})`)

    if (firstClose) {
      // Safety net for attach mode (and a sanity check for self-boot): a real runner would
      // spend money, so the first close must reach the fake within seconds.
      firstClose = false
      const reached = await waitFor(
        `fake runner call for ${fx.slug}`,
        () => Object.keys(readFakeCalls(FAKE_DIR, fx.slug)).length > 0,
        15_000
      ).catch(() => false)
      if (!reached) {
        for (const j of jobsFor(fx.slug))
          if (!isTerminal(j))
            await conn.evalJs(`window.argus.distill.cancel(${j.id})`).catch(() => null)
        abort(
          `FAKE FAIL: no call reached ${FAKE_DIR}/calls.ndjson; the app is not running the fake`
        )
      }
    }

    try {
      await settle(fx.slug, fx.expected.jobs.length > 0)
    } catch (e) {
      check(`${fx.slug}: jobs settled within ${SETTLE_TIMEOUT_MS / 1000}s`, false, e.message)
      continue
    }

    for (const a of fx.actions) {
      if (a.type === 'retract-finding') {
        const r = await conn.evalJs(
          `window.argus.devFindings.retract(${ids.findingIds[a.finding]}, ${JSON.stringify(a.reason)})`
        )
        check(
          `${fx.slug}: retract finding #${a.finding} (id ${ids.findingIds[a.finding]})`,
          r?.ok === true,
          r?.ok ? { changed: r.changed } : r
        )
      } else {
        const p = ((await conn.evalJs(`window.argus.proposals.list()`))?.proposals ?? []).find(
          (x) => x.caseSlug === fx.slug && x.type === a.proposalType && x.target === a.target
        )
        check(`${fx.slug}: staged ${a.proposalType} ${a.target} found`, Boolean(p), p?.file)
        if (p)
          await conn.evalJs(
            `window.argus.proposals.reject(${JSON.stringify(p.file)}, ${JSON.stringify({ tag: a.reason })})`
          )
      }
    }

    const calls = readFakeCalls(FAKE_DIR, fx.slug)
    console.error(`${fx.slug}: fake calls ${JSON.stringify(calls)}`)
    const problems = checkExpected(
      withDb((db) => readActual(db, fx.slug, calls)),
      fx.expected
    )
    check(
      `${fx.slug}: DB matches expected`,
      problems.length === 0,
      problems.length ? problems : undefined
    )
    await assertUi(conn, fx)
  }

  conn.close()
  report()
}

main().catch((e) => {
  console.error('GATE ERROR', e)
  process.exit(1)
})
