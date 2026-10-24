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
 * Boot (default; the helpers live in scripts/lib/fakeBoot.mjs): a scratch home at <os.tmpdir()>/argus-fake-<pid>/home, a free port in
 * 9260-9290, and
 *   npx electron-vite dev -- --remote-debugging-port=<port>
 * from app/ with ARGUS_HOME, ARGUS_HEADLESS_FAKE=<home>/fake-runner, ARGUS_DEV_TOOLS=1. Port
 * flag: verified empirically on electron-vite 5.0.0 (2026-10-21) — `-- --remote-debugging-port=N`
 * (forwarded through ELECTRON_CLI_ARGS) and `--remoteDebuggingPort N` (REMOTE_DEBUGGING_PORT)
 * both bind N; this gate uses the first. The gate waits for /json/version, then for the boot
 * log's `[distill] FAKE RUNNER active: <its own fake dir>`, then for the main window and the
 * renderer — all four inside ONE 180 s boot budget — and aborts (exit 2) if the child log
 * shows the port was taken (`bind() returned an error` / `Cannot start http server`) — that is
 * how a gate ends up driving another worktree's app. Teardown kills only the spawned tree
 * (taskkill /T /F on Windows, the process group elsewhere) and deletes the scratch dir on
 * success; on failure the dir is kept and its path printed.
 *
 * Attach mode: CDP_PORT=<port> ARGUS_HOME=<home> node scripts/cdp-attribution-fake.mjs drives an
 * app you booted yourself with ARGUS_HEADLESS_FAKE=<home>/fake-runner and dev tools on. It must
 * be a FRESH home, and both refusals run before anything is written: a home holding any
 * non-fixture case is refused (FRESH-HOME FAIL, exit 2), and a fixture case that already has
 * sessions is refused (exit 1) rather than re-checked against stale state.
 *
 * Exits 0 when every check passes, 1 when any fails, 2 on an abort (boot / port / identity /
 * fresh home / settings / fake runner not active).
 */
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { waitFor, check, report } from './lib/cdp.mjs'
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
import {
  BOOT_TIMEOUT_MS,
  abort,
  installTeardown,
  freePort,
  bootFakeApp,
  connectRenderer,
  mergeSettings,
  withDb as withDbFile,
  jobsFor as jobsForDb,
  isTerminal,
  settle as settleDb,
  identityPrecheck,
  identityGate
} from './lib/fakeBoot.mjs'

const ATTACH = Boolean(process.env.CDP_PORT && process.env.ARGUS_HOME)
const ROOT = ATTACH ? null : path.join(os.tmpdir(), `argus-fake-${process.pid}`)
const HOME = ATTACH ? path.resolve(process.env.ARGUS_HOME) : path.join(ROOT, 'home')
const FAKE_DIR = path.join(HOME, 'fake-runner')
const DB = path.join(HOME, 'argus.db')
const LOG = ROOT ? path.join(ROOT, 'electron.log') : null
const SETTLE_TIMEOUT_MS = 90_000
const UI_TIMEOUT_MS = 15_000

// ---------- boot + teardown (scripts/lib/fakeBoot.mjs) ----------
installTeardown(ROOT)

// ---------- settings ----------
/** Merge `distill.pipeline` + `distill.attribution.default = true` into the home's settings
 *  file (cdp-attribution.mjs forceSettings): clobbering a valid file would reset the rest. */
const forceSettings = (pipeline) =>
  mergeSettings(HOME, { distill: { pipeline, attribution: { default: true } } })

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
const withDb = (fn) => withDbFile(DB, fn)
const jobsFor = (slug) => jobsForDb(DB, slug)
const settle = (slug, expectJob) => settleDb(DB, slug, expectJob, SETTLE_TIMEOUT_MS)

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
  // Settings + assets go in before boot; in attach mode only after the identity, fresh-home and
  // re-seed refusals below, so a used home is left untouched.
  const prepareHome = () => {
    forceSettings('v3')
    for (const fx of fixtures) writeFixtureAssets(HOME, fx)
  }
  if (!ATTACH) prepareHome()
  const PORT = ATTACH ? process.env.CDP_PORT : await freePort(9260, 9290)
  const bootDeadline = Date.now() + BOOT_TIMEOUT_MS // one budget for every boot wait below
  if (!ATTACH)
    await bootFakeApp({
      home: HOME,
      port: PORT,
      fakeDir: FAKE_DIR,
      log: LOG,
      deadline: bootDeadline
    })
  const conn = await connectRenderer(PORT, bootDeadline)

  // Identity pre-check, BEFORE any write (argus-cdp-port-collision): a wrong CDP_PORT can be
  // another worktree's app, and creating the fixture cases there would pollute its real home.
  // The connected app and ARGUS_HOME/argus.db must hold exactly the same set of cases (both
  // empty for a fresh home; a foreign app with cases, or a different home, mismatches).
  const { existing, dbSlugs } = await identityPrecheck(conn, PORT, DB)

  // Fresh-home refusal (attach mode), still BEFORE any write: the identity check above proves
  // the port and ARGUS_HOME agree, not that the home is a scratch one. A home holding any case
  // that is not a fixture case is somebody's real home — creating fixture cases, editing its
  // settings and writing assets there would pollute it.
  if (ATTACH) {
    const slugs = new Set(fixtures.map((f) => f.slug))
    const foreign = dbSlugs.filter((s) => !slugs.has(s))
    if (foreign.length)
      abort(
        `FRESH-HOME FAIL: ${HOME} holds non-fixture case(s) [${foreign.join(', ')}]; this gate needs a fresh home — unset CDP_PORT/ARGUS_HOME to let it boot its own`
      )
  }

  // Re-seed refusal, before anything is written: a home whose fixture cases already carry
  // sessions would compare stale state (attach mode against a used home). Only cases that
  // already exist can carry sessions, so this needs nothing created first.
  for (const fx of fixtures) {
    const seeded = withDb((db) => {
      const row = db.prepare(`SELECT id FROM cases WHERE slug=?`).get(fx.slug)
      return row
        ? Number(
            db.prepare(`SELECT COUNT(*) AS n FROM sessions WHERE case_id=?`).get(Number(row.id)).n
          )
        : 0
    })
    if (seeded === 0) continue
    console.error(
      `${fx.slug}: already has ${seeded} session(s); refusing to seed twice (attach mode against a used home)\nREFUSING: ${HOME} already holds seeded fixture cases. This gate needs a fresh home — unset CDP_PORT/ARGUS_HOME to let it boot its own.`
    )
    process.exit(1)
  }

  // Cases are created through the app (DB row + case dir), unless they already exist.
  for (const fx of fixtures) {
    if (existing.some((c) => c.slug === fx.slug)) continue
    await conn.evalJs(
      `window.argus.cases.create(${JSON.stringify({ slug: fx.slug, title: fx.title, ...(fx.jiraKey ? { jiraKey: fx.jiraKey } : {}) })})`
    )
  }

  // Identity gate (argus-cdp-port-collision): the port must show OUR fixture cases AND each must
  // be a row in THIS home's DB, which is where every assertion below reads from.
  await identityGate(
    conn,
    PORT,
    DB,
    fixtures.map((f) => f.slug)
  )
  check(
    'identity: every fixture case visible on the connected app AND a row in ARGUS_HOME/argus.db',
    true
  )

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
