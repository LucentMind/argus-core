#!/usr/bin/env node
/**
 * Proposal delete live gate (spec 2026-09-07) — drives the REAL app over CDP against a scratch
 * ARGUS_HOME.
 *
 * What jsdom cannot prove and this does: the Delete button → ConfirmHost dialog → IPC → main
 * `deleteProposal` → `rmSync` → `proposals:changed` broadcast chain end to end, on real files in
 * a real home, with the real preload. It asserts the on-disk invariant the spec is built on —
 * the proposal is gone from `proposals/` and NOTHING appeared under `proposals/archive/` — and
 * that the broadcast a second window would consume actually fires with the decremented count.
 * (The app has a single main window, so the badge-in-another-window check is made through the
 * broadcast subscription, which is exactly the mechanism a second window's badge listens to.)
 *
 * NOT covered here, deliberately: "re-run distill and the deleted item comes back unstamped"
 * needs a paid LLM run whose output is not guaranteed to re-propose the same target, so a green
 * run could prove nothing. That guarantee is pinned by
 * `src/main/services/distill/__tests__/staging.delete.test.ts`, which drives
 * `stageDistillOutput`/`assembleDistillInput` on disk directly.
 *
 * Usage:
 *   1. ARGUS_HOME=<fresh scratch dir> npx electron-vite dev --remoteDebuggingPort 9233
 *   2. ARGUS_HOME=<same> CDP_PORT=9233 node scripts/cdp-proposal-delete.mjs
 *
 * Exits 0 when every check passes, 1 otherwise. Re-runnable: the fixture skips what already
 * exists, and every assertion is about the state this run produces, not about a fresh home.
 *
 * Port-collision trap: a busy debug port silently hands you ANOTHER worktree's app (Electron
 * does not fail when the port is taken). The identity gate below — this fixture's own case must
 * be listable through the connected page's `window.argus` — is what catches that.
 */
import fs from 'node:fs'
import path from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { listTargets, connect, mainWindow, sleep, waitFor, check, report } from './lib/cdp.mjs'

const PORT = process.env.CDP_PORT || '9233'
const HOME = process.env.ARGUS_HOME
if (!HOME) {
  console.error('ARGUS_HOME is required (the scratch home the app was booted against)')
  process.exit(2)
}
const SLUG = 'live-delete-fixture'
const TITLE = 'Proposal delete live fixture'
const PROPOSALS = path.join(HOME, 'proposals')
const ARCHIVE = path.join(PROPOSALS, 'archive')

// ---------- fixture ----------
/** One `distill_jobs` row so the Distillation runs view has something to list for the case. */
function seedJob() {
  const db = new DatabaseSync(path.join(HOME, 'argus.db'))
  const have = db.prepare(`SELECT id FROM distill_jobs WHERE case_slug=? AND kind='case'`).get(SLUG)
  if (have) {
    db.close()
    return Number(have.id)
  }
  const now = new Date().toISOString()
  const r = db
    .prepare(
      `INSERT INTO distill_jobs (case_slug, state, input_snapshot, item_count, created_at, finished_at, kind, dry_run, pipeline)
       VALUES (?, 'done', '{}', 3, ?, ?, 'case', 0, 'v3')`
    )
    .run(SLUG, now, now)
  db.close()
  return Number(r.lastInsertRowid)
}

const fm = (fields, body) =>
  ['---', ...Object.entries(fields).map(([k, v]) => `${k}: ${v}`), '---', '', body].join('\n')

/** Three job-stamped proposals (two flat, one directory-shaped) + one human-authored one. */
function seedProposals(jobId) {
  fs.mkdirSync(PROPOSALS, { recursive: true })
  const date = '2026-09-07T10:00:00.000Z'
  const items = [
    {
      file: `2026-09-07-${SLUG}-alpha-notes.md`,
      title: 'Alpha notes',
      type: 'reference-edit',
      target: 'alpha-notes',
      job: jobId
    },
    {
      file: `2026-09-07-${SLUG}-beta-notes.md`,
      title: 'Beta notes',
      type: 'reference-edit',
      target: 'beta-notes',
      job: jobId
    },
    {
      file: `2026-09-07-${SLUG}-human-note.md`,
      title: 'Human note',
      type: 'reference-edit',
      target: 'human-note'
    }
  ]
  for (const it of items) {
    const p = path.join(PROPOSALS, it.file)
    if (fs.existsSync(p)) continue
    fs.writeFileSync(
      p,
      fm(
        {
          type: it.type,
          target: it.target,
          case: SLUG,
          date,
          title: it.title,
          status: 'pending',
          ...(it.job ? { job: it.job, basis: 'seeded by the live gate for a delete check' } : {})
        },
        `# ${it.title}\n\nSeeded body.\n`
      )
    )
  }
  // Directory-shaped: SKILL.md + a sibling script.
  const dir = path.join(PROPOSALS, `2026-09-07-${SLUG}-gamma-skill`)
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(path.join(dir, 'scripts'), { recursive: true })
    fs.writeFileSync(
      path.join(dir, 'SKILL.md'),
      fm(
        {
          type: 'skill-new',
          target: 'gamma-skill',
          case: SLUG,
          date,
          title: 'Gamma skill',
          status: 'pending',
          job: jobId,
          basis: 'seeded by the live gate for a delete check'
        },
        '---\ndescription: gamma\n---\n# Gamma skill\n'
      )
    )
    fs.writeFileSync(path.join(dir, 'scripts', 'run.sh'), '#!/bin/sh\necho gamma\n')
  }
  return { flat: items, dir: path.basename(dir) }
}

const archiveEntries = () => (fs.existsSync(ARCHIVE) ? fs.readdirSync(ARCHIVE).sort() : [])

// ---------- renderer helpers ----------
const byLabel = (label) => `[aria-label=${JSON.stringify(label)}]`
const clickByLabel = (conn, label) =>
  conn.evalJs(`(() => {
    const el = document.querySelector(${JSON.stringify(byLabel(label))})
    if (!el) return false
    el.click()
    return true
  })()`)
const hasLabel = (conn, label) =>
  conn.evalJs(`Boolean(document.querySelector(${JSON.stringify(byLabel(label))}))`)
/** The confirm dialog ConfirmHost renders: ModalShell role=dialog, aria-label = the title. */
const DIALOG = byLabel('Delete this proposal?')
const dialogOpen = (conn) =>
  conn.evalJs(`Boolean(document.querySelector(${JSON.stringify(DIALOG)}))`)
const clickDialogButton = (conn, text) =>
  conn.evalJs(`(() => {
    const d = document.querySelector(${JSON.stringify(DIALOG)})
    if (!d) return false
    const b = [...d.querySelectorAll('button')].find((x) => x.textContent.trim() === ${JSON.stringify(text)})
    if (!b) return false
    b.click()
    return true
  })()`)
const badgeCount = (conn) =>
  conn.evalJs(`(() => {
    const b = document.querySelector(${JSON.stringify(byLabel('Proposals'))})
    const s = b?.querySelector('span')
    return s ? Number(s.textContent) : 0
  })()`)
const skipOnboarding = async (conn) => {
  await conn.evalJs(`(() => {
    const b = [...document.querySelectorAll('button')].find((x) => x.textContent.trim() === 'Skip setup')
    if (b) b.click()
    return Boolean(b)
  })()`)
  await sleep(500)
}
/** Open the Proposals view (top-bar inbox). Idempotent: only clicks when no queue row is visible. */
const openProposals = async (conn) => {
  const onView = () =>
    conn.evalJs(`Boolean(document.querySelector('[aria-label^="Select proposal "]'))`)
  if (!(await onView())) {
    await clickByLabel(conn, 'Proposals')
    await sleep(600)
  }
  await waitFor('the proposals queue', onView, 10000)
}

// ---------- drive ----------
const main = async () => {
  const targets = await waitFor(
    'a page target',
    async () => {
      const t = await listTargets(PORT).catch(() => [])
      return t.length > 0 ? t : null
    },
    120000
  )
  const conn = await connect(mainWindow(targets))
  await waitFor('the app shell', () => conn.evalJs(`Boolean(document.querySelector('body *'))`))
  await sleep(1500)
  await skipOnboarding(conn)

  // Case through the app's own IPC so the case dir/case.json exist.
  const created = await conn.evalJs(
    `window.argus.cases.list().then((l) => (l.cases ?? l).some((c) => c.slug === ${JSON.stringify(SLUG)}))`
  )
  if (!created) {
    await conn.evalJs(
      `window.argus.cases.create(${JSON.stringify({ slug: SLUG, title: TITLE })}).then(() => true)`
    )
    await sleep(800)
  }
  // Identity gate (port-collision trap): the page we are talking to must see OUR fixture case.
  const seesCase = await conn.evalJs(
    `window.argus.cases.list().then((l) => (l.cases ?? l).some((c) => c.slug === ${JSON.stringify(SLUG)}))`
  )
  check('identity: connected page lists the fixture case (right app on this port)', seesCase)
  if (!seesCase) report()

  const jobId = seedJob()
  const seeded = seedProposals(jobId)
  const beta = seeded.flat[1]
  const alpha = seeded.flat[0]
  const human = seeded.flat[2]

  // The proposals dir watcher (300ms debounce) must surface externally written files.
  const listed = await waitFor(
    'all 4 seeded proposals listed via IPC',
    async () => {
      const l = await conn.evalJs(`window.argus.proposals.list()`)
      const files = new Set(l.proposals.map((p) => p.file))
      return [alpha.file, beta.file, human.file, seeded.dir].every((f) => files.has(f)) ? l : null
    },
    15000
  )
  const pendingBefore = listed.proposals.length
  check(
    'fixture: 4 pending proposals visible through the preload',
    pendingBefore >= 4,
    pendingBefore
  )
  const archiveBefore = archiveEntries()

  await openProposals(conn)
  check(
    'proposals view: fixture rows present',
    await hasLabel(conn, `Select proposal ${beta.title}`)
  )

  // Subscribe to the broadcast a second window's badge would consume.
  await conn.evalJs(`(() => {
    window.__deleteEvents = []
    window.__unsubDelete?.()
    window.__unsubDelete = window.argus.proposals.onChanged((c) => window.__deleteEvents.push(c))
    return true
  })()`)

  // --- Cancel path ---
  await clickByLabel(conn, `Select proposal ${beta.title}`)
  await sleep(300)
  check(
    'delete button rendered for the selected proposal',
    await hasLabel(conn, `Delete ${beta.title}`)
  )
  await clickByLabel(conn, `Delete ${beta.title}`)
  await waitFor('confirm dialog', () => dialogOpen(conn), 5000)
  const dialogText = await conn.evalJs(
    `document.querySelector(${JSON.stringify(DIALOG)}).innerText`
  )
  check(
    'confirm dialog carries the spec copy',
    /without recording a rejection/.test(dialogText) &&
      /may propose the same thing again/.test(dialogText),
    dialogText
  )
  await clickDialogButton(conn, 'Cancel')
  await sleep(500)
  check('cancel: dialog closed', !(await dialogOpen(conn)))
  check('cancel: row still listed', await hasLabel(conn, `Select proposal ${beta.title}`))
  check('cancel: file still on disk', fs.existsSync(path.join(PROPOSALS, beta.file)))
  check(
    'cancel: no proposals:changed broadcast fired',
    (await conn.evalJs(`window.__deleteEvents.length`)) === 0
  )

  // --- Confirm path (flat proposal) ---
  await clickByLabel(conn, `Delete ${beta.title}`)
  await waitFor('confirm dialog (again)', () => dialogOpen(conn), 5000)
  check('confirm: dialog Delete button clicked', await clickDialogButton(conn, 'Delete'))
  await waitFor(
    'row removed from the queue',
    async () => !(await hasLabel(conn, `Select proposal ${beta.title}`)),
    10000
  )
  check('confirm: file removed from proposals/', !fs.existsSync(path.join(PROPOSALS, beta.file)))
  check(
    'confirm: archive/ gained nothing',
    archiveEntries().join('|') === archiveBefore.join('|'),
    {
      before: archiveBefore.length,
      after: archiveEntries().length
    }
  )
  const events = await conn.evalJs(`window.__deleteEvents`)
  check(
    'confirm: proposals:changed broadcast fired with the decremented count',
    events.length >= 1 && events[events.length - 1].pendingCount === pendingBefore - 1,
    events
  )
  check(
    'confirm: top-bar badge shows the decremented count',
    (await badgeCount(conn)) === pendingBefore - 1
  )
  // Selection advanced to a neighbour — some other pending row is now aria-current.
  const current = await conn.evalJs(
    `[...document.querySelectorAll('[aria-label^="Select proposal "]')].find((b) => b.getAttribute('aria-current') === 'true')?.getAttribute('aria-label') ?? null`
  )
  check(
    'confirm: selection advanced to a neighbouring row',
    current !== null && !current.endsWith(beta.title),
    current
  )

  // --- Confirm path (directory-shaped proposal) ---
  await clickByLabel(conn, 'Select proposal Gamma skill')
  await sleep(300)
  await clickByLabel(conn, 'Delete Gamma skill')
  await waitFor('confirm dialog (dir)', () => dialogOpen(conn), 5000)
  await clickDialogButton(conn, 'Delete')
  await waitFor(
    'dir row removed',
    async () => !(await hasLabel(conn, 'Select proposal Gamma skill')),
    10000
  )
  check('dir delete: whole tree removed', !fs.existsSync(path.join(PROPOSALS, seeded.dir)))
  check(
    'dir delete: archive/ still unchanged',
    archiveEntries().join('|') === archiveBefore.join('|')
  )

  // --- Contrast: reject still archives (so the gate cannot pass on a broken archive dir) ---
  await clickByLabel(conn, `Select proposal ${human.title}`)
  await sleep(300)
  await clickByLabel(conn, `Reject ${human.title}`)
  await sleep(300)
  await clickByLabel(conn, 'Reject without a reason')
  await waitFor(
    'rejected row removed',
    async () => !(await hasLabel(conn, `Select proposal ${human.title}`)),
    10000
  )
  check(
    'contrast: reject DID add an archive entry (delete did not)',
    archiveEntries().length === archiveBefore.length + 1,
    archiveEntries()
  )

  // --- Distillation runs view still lists the run (dev-gated; a dev boot has devTools on) ---
  await clickByLabel(conn, 'Distillation runs')
  await sleep(1000)
  const runsText = await conn.evalJs(`document.body.innerText`)
  check(
    'runs view: the seeded run is still listed after deleting two of its items',
    new RegExp(`#${jobId}\\b`).test(runsText) && /3 staged/.test(runsText),
    {
      jobId,
      sample: runsText
        .split('\n')
        .filter((l) => l.includes(`#${jobId}`))
        .slice(0, 2)
    }
  )

  await conn.evalJs(`(window.__unsubDelete?.(), true)`)
  conn.close()
  report()
}

main().catch((e) => {
  console.error('GATE ERROR:', e.message)
  process.exit(1)
})
