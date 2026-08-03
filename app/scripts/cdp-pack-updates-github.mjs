#!/usr/bin/env node
/**
 * Runtime gate for the GitHub-Releases pack source
 * (plan 2026-08-03-pack-updates-github-source.md; exit-check Part 2).
 *
 * Every `gh` call in the vitest suite is an injected fake, so the production `nodeGhClient`
 * — the subprocess seam that actually talks to GitHub — has never executed. This drives the
 * real IPC against a real PRIVATE repository, which is the case the whole feature exists for
 * and the one thing a public repo cannot stand in for.
 *
 * Usage:
 *   1. ARGUS_HOME=<tmp> npx electron-vite dev --remoteDebuggingPort 9223
 *   2. ARGUS_HOME=<same tmp> node scripts/cdp-pack-updates-github.mjs
 *
 * Requires `gh` signed in to an account that can see LucentMind/demo_pack_private. The script
 * publishes v0.3.0 and a draft v0.4.0 to that repo as part of the run, and removes the draft
 * afterwards.
 *
 * Env: CDP_PORT (default 9223), ARGUS_HOME (required). Exits 0 when every check passes.
 */
import { execFileSync } from 'node:child_process'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { dirname, resolve as resolvePath } from 'node:path'
import { listTargets, connect, mainWindow, sleep, check, report } from './lib/cdp.mjs'

const PORT = process.env.CDP_PORT || '9223'
const HOME = process.env.ARGUS_HOME
const REPO = 'LucentMind/demo_pack_private'
const PACK = 'private-playground'
const WORKTREE_ROOT = resolvePath(dirname(fileURLToPath(import.meta.url)), '..', '..')

if (!HOME) {
  console.error('ARGUS_HOME must be set, and must match the one the app was booted with.')
  process.exit(1)
}

const gh = (args) => execFileSync('gh', args, { encoding: 'utf8', timeout: 60000 }).trim()

/**
 * The port-ownership check that a previous gate learned the hard way: two worktrees both
 * running `--remoteDebuggingPort 9223` means the second binds nothing, and an unchecked gate
 * then silently validates the FIRST worktree's app. A mismatch is the one outcome that must
 * never pass quietly.
 */
function verifyPortOwnership() {
  if (process.platform !== 'win32') return
  let out
  try {
    out = execFileSync(
      'powershell',
      [
        '-NoProfile',
        '-Command',
        `$p = Get-NetTCPConnection -LocalPort ${PORT} -State Listen -ErrorAction SilentlyContinue | ` +
          `Select-Object -First 1 -ExpandProperty OwningProcess; ` +
          `if ($p) { (Get-CimInstance Win32_Process -Filter "ProcessId=$p").CommandLine } else { 'NOMATCH' }`
      ],
      { encoding: 'utf8', timeout: 8000 }
    ).trim()
  } catch {
    console.error(`WARNING: could not resolve the owner of port ${PORT} — proceeding unchecked.`)
    return
  }
  if (out === 'NOMATCH' || !out) return
  if (!out.includes(path.basename(WORKTREE_ROOT))) {
    console.error(`FATAL: port ${PORT} is held by another checkout, not ${WORKTREE_ROOT}:\n${out}`)
    process.exit(1)
  }
}

/** `packsStatePath` — under config/, not the home root. */
const STATE = path.join(HOME, 'config', 'packs-state.json')

/**
 * `packsDir` honours an ambient ARGUS_PACKS_DIR, which IS set machine-wide on this box — so an
 * "isolated" ARGUS_HOME alone still installs into the shared dev packs dir. Boot the app with
 * ARGUS_PACKS_DIR pointed inside the throwaway home, and read the same variable here so the two
 * cannot drift apart.
 */
const PACKS_DIR = process.env.ARGUS_PACKS_DIR ?? path.join(HOME, 'packs')

const state = () => (fs.existsSync(STATE) ? JSON.parse(fs.readFileSync(STATE, 'utf8')) : {})

/** The pin as the app has it on disk, or null. */
const pin = () => state().sources?.[PACK] ?? null

const installedVersion = () => state().packs?.[PACK] ?? null

/** Text of the installed panel's index.html — proof the BYTES swapped, not just a version string. */
const panelHeading = () => {
  const f = path.join(PACKS_DIR, PACK, 'ui', 'playground', 'index.html')
  if (!fs.existsSync(f)) return null
  return (fs.readFileSync(f, 'utf8').match(/<h1>(.*?)<\/h1>/) ?? [])[1] ?? null
}

/** Best-effort `gh`, for teardown steps that must not fail a re-run when there is nothing there. */
const ghTry = (args) => {
  try {
    return gh(args)
  } catch {
    return null
  }
}

/**
 * Put both sides back to the state this gate assumes: the repo at v0.2.0, and the app with the
 * pack uninstalled. Without this the gate is single-shot — the second run finds v0.3.0 already
 * published and every "is it offered?" assertion becomes meaningless.
 *
 * The app is NOT restarted: `PacksStateStore` re-reads its file on every call, so deleting the
 * state is enough for the running process to see an empty install set.
 */
function reset() {
  ghTry(['release', 'delete', 'v0.3.0', '-R', REPO, '--yes'])
  ghTry(['release', 'delete', 'v0.4.0', '-R', REPO, '--yes'])
  ghTry(['api', '-X', 'DELETE', `repos/${REPO}/git/refs/tags/v0.3.0`])
  fs.rmSync(path.join(PACKS_DIR, PACK), { recursive: true, force: true })
  fs.rmSync(path.join(PACKS_DIR, `${PACK}.bak`), { recursive: true, force: true })
  fs.rmSync(STATE, { force: true })
}

/**
 * Poll `checkUpdates` until `pred` holds. GitHub's release list is eventually consistent: a
 * `gh release create` that has already returned is not necessarily visible to the next API read.
 * An immediate single assertion here reported "no update" and made three later checks cascade —
 * a defect in the gate, not in the app.
 */
async function waitForUpdate(pred, label, timeoutMs = 90000) {
  const started = Date.now()
  let last
  while (Date.now() - started < timeoutMs) {
    last = (await pollIpc('window.argus.packs.checkUpdates()'))?.[PACK]
    if (pred(last)) return last
    await sleep(3000)
  }
  console.error(`  (${label}: gave up after ${timeoutMs}ms, last was ${JSON.stringify(last)})`)
  return last
}

let pollIpc

async function main() {
  verifyPortOwnership()
  reset()

  const targets = await listTargets(PORT)
  const conn = await connect(mainWindow(targets))
  const ipc = (expr) => conn.evalJs(`(async () => { return ${expr} })()`)
  pollIpc = ipc

  // ── discovery ───────────────────────────────────────────────────────────────
  const listed = await ipc(`window.argus.packs.inspectRepo(${JSON.stringify(REPO)})`)
  check('a private repo can be listed at all', listed?.ok === true, JSON.stringify(listed))
  const row = listed?.packs?.find((p) => p.id === PACK)
  check(
    'the private pack is offered as installable',
    row?.installable === true,
    JSON.stringify(row)
  )

  // ── install ─────────────────────────────────────────────────────────────────
  const installed = await ipc(
    `window.argus.packs.installFromRepo(${JSON.stringify(REPO)}, ${JSON.stringify(PACK)})`
  )
  check('install from a private repo succeeds', installed?.ok === true, JSON.stringify(installed))
  check(
    'the installed version is what the repo published',
    installedVersion() === row?.version,
    `state=${installedVersion()} listed=${row?.version}`
  )

  const p1 = pin()
  check(
    'the pin is the REPO, resolved canonically',
    p1?.kind === 'github' && p1?.owner === 'LucentMind' && p1?.repo === 'demo_pack_private',
    JSON.stringify(p1)
  )
  check(
    'the pin carries the resolved manifest path',
    p1?.manifestPath === `packs/${PACK}/argus-pack.json`,
    String(p1?.manifestPath)
  )

  // ── no update when there is none ────────────────────────────────────────────
  const idle = await ipc('window.argus.packs.checkUpdates()')
  check(
    'nothing newer published ⇒ idle, not an error',
    idle?.[PACK]?.phase === 'idle',
    JSON.stringify(idle?.[PACK])
  )

  // ── publish a newer release, then update ────────────────────────────────────
  const staging = path.join(HOME, '..', 'gate-staging')
  fs.rmSync(staging, { recursive: true, force: true })
  fs.mkdirSync(path.join(staging, 'bin'), { recursive: true })
  fs.cpSync(path.join(PACKS_DIR, PACK), path.join(staging, PACK), { recursive: true })
  const mf = path.join(staging, PACK, 'argus-pack.json')
  const manifest = JSON.parse(fs.readFileSync(mf, 'utf8'))
  manifest.version = '0.3.0'
  delete manifest.platform // build stamps it; a stale stamp would be rejected at install
  fs.writeFileSync(mf, JSON.stringify(manifest, null, 2))
  const html = path.join(staging, PACK, 'ui', 'playground', 'index.html')
  fs.writeFileSync(
    html,
    fs.readFileSync(html, 'utf8').replace(/<h1>.*?<\/h1>/, '<h1>Bridge Playground — v0.3.0</h1>')
  )
  fs.rmSync(path.join(staging, 'CHECKSUMS'), { force: true })

  const cli = path.join(WORKTREE_ROOT, 'tools', 'pack-tools', 'dist', 'cli.js')
  for (const plat of ['win-x64', 'mac-arm64']) {
    execFileSync(
      process.execPath,
      [
        cli,
        'build',
        '--pack',
        path.join(staging, PACK),
        '--bin',
        path.join(staging, 'bin'),
        '--platform',
        plat,
        '--out',
        path.join(staging, 'dist')
      ],
      { encoding: 'utf8' }
    )
  }
  // The tag must carry the bumped manifest: argusApi is read from the TAGGED tree, and the
  // asset filenames are matched against it.
  gh([
    'api',
    `repos/${REPO}/git/refs`,
    '-f',
    'ref=refs/tags/v0.3.0',
    '-f',
    `sha=${gh(['api', `repos/${REPO}/commits/main`, '--jq', '.sha'])}`
  ])
  gh([
    'release',
    'create',
    'v0.3.0',
    '-R',
    REPO,
    '--title',
    'v0.3.0',
    '--notes',
    'gate',
    ...fs
      .readdirSync(path.join(staging, 'dist'))
      .filter((f) => f.includes('0.3.0'))
      .map((f) => path.join(staging, 'dist', f))
  ])

  const avail = await waitForUpdate((s) => s?.phase === 'available', 'publish→offered')
  check(
    'a newly published release is offered',
    avail?.phase === 'available' && avail?.version === '0.3.0',
    JSON.stringify(avail)
  )

  const applied = await ipc(`window.argus.packs.applyUpdate(${JSON.stringify(PACK)})`)
  check(
    'applying downloads, verifies and installs',
    applied?.phase === 'ready' && applied?.version === '0.3.0',
    JSON.stringify(applied)
  )
  check('the bytes on disk actually swapped', panelHeading()?.includes('v0.3.0'), panelHeading())

  // THE regression the whole-branch review caught: installPack re-deriving the pin from the
  // updated bundle's manifest silently re-pointed or DELETED it.
  const p2 = pin()
  check(
    'the github pin SURVIVES an applied update',
    p2?.kind === 'github' && p2?.repo === 'demo_pack_private',
    JSON.stringify(p2)
  )

  // ── a draft is not an update ────────────────────────────────────────────────
  gh([
    'release',
    'create',
    'v0.4.0',
    '-R',
    REPO,
    '--draft',
    '--title',
    'v0.4.0',
    '--notes',
    'draft',
    ...fs
      .readdirSync(path.join(staging, 'dist'))
      .filter((f) => f.includes('0.3.0'))
      .map((f) => path.join(staging, 'dist', f))
  ])
  // Poll for the inverse too: a draft that is genuinely never offered is indistinguishable from
  // one that has not propagated yet, so give it the same window the positive case got before
  // concluding. Anything other than a sustained `idle` fails.
  await sleep(5000)
  const afterDraft = await waitForUpdate((s) => s?.phase !== 'idle', 'draft→offered?', 20000)
  check(
    'a draft release is never offered',
    afterDraft?.phase === 'idle',
    JSON.stringify(afterDraft)
  )
  gh(['release', 'delete', 'v0.4.0', '-R', REPO, '--yes'])

  // ── a repo that is not there ────────────────────────────────────────────────
  const missing = await ipc(
    `window.argus.packs.inspectRepo("LucentMind/definitely-not-a-real-repo-xyz")`
  )
  check(
    'an invisible repo fails with a message, not a crash',
    missing?.ok === false && typeof missing.error === 'string' && missing.error.length > 0,
    JSON.stringify(missing)
  )

  // ── the security property: a moved repo is refused ──────────────────────────
  // Opt-in, because it RENAMES the test repository. Guarded so an ordinary run never mutates a
  // repo name, and wrapped so the rename is undone even if an assertion throws.
  if (process.env.GATE_RENAME === '1') {
    const renamed = `${REPO.split('/')[1]}-moved`
    gh(['api', '-X', 'PATCH', `repos/${REPO}`, '-f', `name=${renamed}`])
    try {
      // GitHub keeps serving the OLD name via a redirect, so the request still succeeds — the
      // only thing that gives the move away is the canonical name in the response.
      const moved = await waitForUpdate((s) => s?.phase === 'error', 'rename→refused', 60000)
      check(
        'a renamed repository is refused, not silently followed',
        moved?.phase === 'error' && moved?.code === 'origin-pin',
        JSON.stringify(moved)
      )
    } finally {
      // GitHub SERIALIZES renames: a PATCH issued too soon after the first one fails 422 with
      // "a conflicting repository operation is still in progress". A single best-effort restore
      // therefore leaves the repository under the wrong name — retry until it takes.
      let restored = false
      for (let i = 0; i < 8 && !restored; i++) {
        await sleep(10000)
        restored =
          ghTry([
            'api',
            '-X',
            'PATCH',
            `repos/${REPO.split('/')[0]}/${renamed}`,
            '-f',
            `name=${REPO.split('/')[1]}`
          ]) !== null
      }
      check(`the test repository was renamed back to ${REPO}`, restored, `restored=${restored}`)
    }
  }

  conn.close()
  report()
}

main().catch((e) => {
  console.error(e)
  process.exit(1)
})
