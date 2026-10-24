// Shared boot / teardown / settle helpers for the self-booting fake-runner CDP gates
// (cdp-attribution-fake.mjs, cdp-observability-otlp.mjs). Each gate process boots at most ONE
// app, so the spawned child and its log are module state: `abort` can print the log's tail from
// anywhere, and the exit handler kills exactly the tree this process spawned.
//
// Boot: `npx electron-vite dev -- --remote-debugging-port=<port>` from app/ with ARGUS_HOME,
// ARGUS_HEADLESS_FAKE=<fakeDir>, ARGUS_DEV_TOOLS=1. Port flag: verified empirically on
// electron-vite 5.0.0 (2026-10-21) — `-- --remote-debugging-port=N` (forwarded through
// ELECTRON_CLI_ARGS) and `--remoteDebuggingPort N` (REMOTE_DEBUGGING_PORT) both bind N; this
// uses the first. Electron does NOT fail when the port is taken: the child log's
// `bind() returned an error` / `Cannot start http server` is the only signal, and missing it is
// how a gate ends up driving another worktree's app (argus-cdp-port-collision) — `logGuard`
// aborts on it, and every gate still runs its own identity gate after connecting.
import { DatabaseSync } from 'node:sqlite'
import { spawn, execSync } from 'node:child_process'
import fs from 'node:fs'
import net from 'node:net'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { listTargets, connect, mainWindow, sleep, waitFor } from './cdp.mjs'

export const APP_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..')
export const WIN = process.platform === 'win32'
export const PORT_COLLISION = /bind\(\) returned an error|Cannot start http server/
/** ONE budget for the whole boot — /json/version, `FAKE RUNNER active`, the main-window target
 *  and the renderer — so the worst case is bounded (a CI step's timeout-minutes is a backstop,
 *  not the plan). */
export const BOOT_TIMEOUT_MS = 180_000

let child = null
let childLog = ''
let childExited = null
let logFile = null

/** What the spawned app has logged so far ('' before / without a boot). */
export const appLog = () => childLog

/** Abort (exit 2). The tail of the child's boot log goes to stderr too, so a CI failure is
 *  diagnosable from the job output alone (the kept electron.log is not an artifact there). */
export const abort = (msg) => {
  console.error(msg)
  if (childLog)
    console.error(
      `--- last 40 lines of the app's boot log (${logFile}) ---\n${childLog.trimEnd().split(/\r?\n/).slice(-40).join('\n')}`
    )
  process.exit(2)
}

/** Abort when the child's log shows the port was taken or the child died. A no-op without a
 *  spawned child (attach mode). Runs during boot and once more right before the first write. */
export function logGuard(port) {
  if (PORT_COLLISION.test(childLog))
    abort(`PORT FAIL: port ${port} was taken (child log: bind error); refusing to drive it`)
  if (childExited !== null)
    abort(`BOOT FAIL: electron-vite exited (${childExited}) before the app was ready`)
}

/** Kill only the spawned tree (taskkill /T /F on Windows, the process group elsewhere). */
export function killChild() {
  if (!child || childExited !== null) return
  try {
    if (WIN) execSync(`taskkill /PID ${child.pid} /T /F`, { stdio: 'ignore' })
    else process.kill(-child.pid, 'SIGKILL')
  } catch {
    /* already gone */
  }
  child = null
}

/** On exit: kill the child; delete `root` (the scratch dir) on success, keep and print it on
 *  failure. `root` null (attach mode) only kills. SIGINT/SIGTERM exit 130 through the same path. */
export function installTeardown(root, extra = () => {}) {
  process.on('exit', (code) => {
    killChild()
    extra()
    if (!root) return
    if (code === 0) {
      try {
        fs.rmSync(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 300 })
      } catch (e) {
        console.error(`scratch dir not removed (${e.message}): ${root}`)
      }
    } else {
      console.error(`scratch dir kept for inspection: ${root}`)
    }
  })
  for (const sig of ['SIGINT', 'SIGTERM']) process.on(sig, () => process.exit(130))
}

/** First port in [lo, hi] that nothing listens on: it must refuse CDP AND accept a bind.
 *  Aborts (exit 2) when the whole range is taken. */
export async function freePort(lo, hi) {
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

export const samePath = (a, b) => {
  const n = (p) => path.resolve(p).replace(/[\\/]+$/, '')
  return WIN ? n(a).toLowerCase() === n(b).toLowerCase() : n(a) === n(b)
}

/**
 * Spawn the app against `home` with the fake runner reading `fakeDir`, then wait for
 * /json/version and the boot log's `[distill] FAKE RUNNER active: <fakeDir>` inside the boot
 * budget ending at `deadline`. Ambient ARGUS_* and CDP_PORT never reach the app (a shell left
 * over from another worktree's session): only `ARGUS_HOME`, `ARGUS_HEADLESS_FAKE`,
 * `ARGUS_DEV_TOOLS` and `extraEnv`. The child's output is teed synchronously into `log`, so
 * nothing is left buffered when `abort` calls process.exit. Every failure aborts (exit 2).
 */
export async function bootFakeApp({
  home,
  port,
  fakeDir,
  extraEnv = {},
  log,
  deadline = Date.now() + BOOT_TIMEOUT_MS
}) {
  const left = () => Math.max(1000, deadline - Date.now())
  const args = ['electron-vite', 'dev', '--', `--remote-debugging-port=${port}`]
  logFile = log
  fs.writeFileSync(log, '')
  const env = Object.fromEntries(
    Object.entries(process.env).filter(([k]) => !/^ARGUS_/.test(k) && k !== 'CDP_PORT')
  )
  Object.assign(env, {
    ARGUS_HOME: home,
    ARGUS_HEADLESS_FAKE: fakeDir,
    ARGUS_DEV_TOOLS: '1',
    ELECTRON_DISABLE_SECURITY_WARNINGS: '1',
    ...extraEnv
  })
  child = spawn(WIN ? 'npx.cmd' : 'npx', args, {
    cwd: APP_DIR,
    env,
    stdio: ['ignore', 'pipe', 'pipe'],
    shell: WIN,
    detached: !WIN
  })
  const tee = (d) => {
    childLog += d.toString()
    fs.appendFileSync(log, d)
  }
  child.stdout.on('data', tee)
  child.stderr.on('data', tee)
  child.on('exit', (code) => {
    childExited = code ?? -1
  })
  console.error(`booting: npx ${args.join(' ')} (home ${home}, log ${log})`)
  const guard = () => logGuard(port)
  await waitFor(
    `CDP endpoint on ${port}`,
    async () => {
      guard()
      return fetch(`http://127.0.0.1:${port}/json/version`, { signal: AbortSignal.timeout(1000) })
        .then((r) => r.ok)
        .catch(() => false)
    },
    left()
  ).catch(() =>
    abort(`BOOT FAIL: no CDP endpoint on ${port} within the ${BOOT_TIMEOUT_MS / 1000}s boot budget`)
  )
  const fakeLine = await waitFor(
    'FAKE RUNNER active in the boot log',
    () => {
      guard()
      return /\[distill\] FAKE RUNNER active: (.+)/.exec(childLog)?.[1].trim() ?? null
    },
    left()
  ).catch(() =>
    abort(
      `BOOT FAIL: the boot log never said \`[distill] FAKE RUNNER active\` within the ${BOOT_TIMEOUT_MS / 1000}s boot budget`
    )
  )
  if (!samePath(fakeLine, fakeDir))
    abort(`BOOT FAIL: the fake runner reads ${fakeLine}, not this gate's ${fakeDir}`)
  guard()
  return { child, kill: killChild }
}

/** The main window's renderer over CDP, once it exposes window.argus and the top bar. Aborts
 *  (exit 2) when either is missing by `deadline`. */
export async function connectRenderer(port, deadline) {
  const left = () => Math.max(1000, deadline - Date.now())
  const target = await waitFor(
    'main window target',
    async () => mainWindow(await listTargets(port).catch(() => [])) ?? null,
    left()
  ).catch(() => abort(`BOOT FAIL: no main window target on ${port}`))
  const conn = await connect(target)
  await waitFor(
    'renderer ready (preload + top bar)',
    () =>
      conn
        .evalJs(
          `typeof window.argus?.cases?.list === 'function' && Boolean(document.querySelector('button[aria-label="All cases"]'))`
        )
        .catch(() => false),
    left()
  ).catch(() => abort('BOOT FAIL: the renderer never exposed window.argus and the top bar'))
  console.error(`connected to ${port}: ${target.url}`)
  return conn
}

const isObj = (v) => typeof v === 'object' && v !== null && !Array.isArray(v)
const deepMerge = (base, patch) => {
  const out = { ...base }
  for (const [k, v] of Object.entries(patch))
    out[k] = isObj(v) && isObj(base[k]) ? deepMerge(base[k], v) : v
  return out
}

/** Deep-merge `patch` into `<home>/config/settings.json` (objects merge, everything else is
 *  replaced): clobbering a valid file would reset the rest. The app watches the file. */
export function mergeSettings(home, patch) {
  const file = path.join(home, 'config', 'settings.json')
  let cur = {}
  try {
    cur = JSON.parse(fs.readFileSync(file, 'utf8'))
  } catch {
    /* absent or unparseable */
  }
  fs.mkdirSync(path.dirname(file), { recursive: true })
  fs.writeFileSync(file, JSON.stringify(deepMerge(isObj(cur) ? cur : {}, patch), null, 2))
}

// ---------- DB ----------
export const withDb = (dbFile, fn) => {
  const db = new DatabaseSync(dbFile)
  try {
    // The app writes this DB concurrently: wait out its write lock instead of failing
    // SQLITE_BUSY on the first collision.
    db.exec('PRAGMA busy_timeout = 5000')
    return fn(db)
  } finally {
    db.close()
  }
}
export const jobsFor = (dbFile, slug) =>
  withDb(dbFile, (db) =>
    db.prepare(`SELECT id, kind, state FROM distill_jobs WHERE case_slug=? ORDER BY id`).all(slug)
  )
export const isTerminal = (j) =>
  j.state === 'done' || j.state === 'failed' || j.state === 'cancelled'

/** >= 1 job (when expected), all terminal, then a short window so an escape-hatch enqueue
 *  triggered by the last job's finish has landed. Throws on timeout. */
export async function settle(dbFile, slug, expectJob, timeoutMs) {
  const t0 = Date.now()
  const left = () => Math.max(1000, timeoutMs - (Date.now() - t0))
  if (expectJob) await waitFor(`a job for ${slug}`, () => jobsFor(dbFile, slug).length > 0, left())
  await waitFor(
    `${slug} jobs terminal`,
    () => {
      const js = jobsFor(dbFile, slug)
      return js.every(isTerminal) && (!expectJob || js.length > 0)
    },
    left()
  )
  await sleep(3000)
  await waitFor(
    `${slug} jobs terminal (after settle)`,
    () => jobsFor(dbFile, slug).every(isTerminal),
    left()
  )
  console.error(`${slug}: terminal after ${((Date.now() - t0) / 1000).toFixed(1)}s`)
}

// ---------- identity (argus-cdp-port-collision) ----------
const caseSlugsInDb = (dbFile) =>
  withDb(dbFile, (db) =>
    db
      .prepare(`SELECT slug FROM cases`)
      .all()
      .map((r) => r.slug)
      .sort()
  )

/** BEFORE any write: the connected app and `dbFile` must hold exactly the same set of cases
 *  (both empty for a fresh home; a foreign app with cases, or a different home, mismatches).
 *  Returns the app's case list and the DB's slugs. Aborts (exit 2) on a mismatch. */
export async function identityPrecheck(conn, port, dbFile) {
  logGuard(port) // a bind-error line can land after `FAKE RUNNER active`
  const existing = (await conn.evalJs(`window.argus.cases.list()`)) ?? []
  const appSlugs = existing.map((c) => c.slug).sort()
  const dbSlugs = fs.existsSync(dbFile) ? caseSlugsInDb(dbFile) : null
  if (dbSlugs === null)
    abort(`IDENTITY FAIL: ${dbFile} does not exist; the connected app is not using this ARGUS_HOME`)
  if (appSlugs.join('\n') !== dbSlugs.join('\n'))
    abort(
      `IDENTITY FAIL: port ${port} lists cases [${appSlugs.join(', ')}] but ${dbFile} holds [${dbSlugs.join(', ')}]; the connected app is not using this ARGUS_HOME`
    )
  return { existing, dbSlugs }
}

/** AFTER creating cases through the app: the port must show every one of `slugs` AND each must
 *  be a row in `dbFile`, which is where the gate's DB reads go. Aborts (exit 2) otherwise. */
export async function identityGate(conn, port, dbFile, slugs) {
  const cases = (await conn.evalJs(`window.argus.cases.list()`)) ?? []
  const missing = slugs.filter((s) => !cases.some((c) => c.slug === s))
  if (missing.length)
    abort(
      `IDENTITY FAIL: port ${port} does not show fixture case(s) ${missing.join(', ')}; refusing to continue`
    )
  if (!fs.existsSync(dbFile))
    abort(`IDENTITY FAIL: ${dbFile} does not exist; the connected app is not using this ARGUS_HOME`)
  const notInDb = withDb(dbFile, (db) =>
    slugs.filter((s) => !db.prepare(`SELECT 1 FROM cases WHERE slug=?`).get(s))
  )
  if (notInDb.length)
    abort(
      `IDENTITY FAIL: fixture case(s) ${notInDb.join(', ')} are not rows in ${dbFile}; the connected app is not using this ARGUS_HOME`
    )
}
