#!/usr/bin/env node
/**
 * Credential-free OTLP observability gate — drives the REAL app over CDP with the headless
 * runners replaced by the fixture-driven fake (src/main/services/distill/fakeRunner.ts) and the
 * OTLP provider pointed at a local receiver (scripts/lib/otlpReceiver.mjs), so it costs nothing,
 * needs no login and no collector, and can run in CI.
 *
 * What a seeded fixture close emits through OTLP: there is no live agent session, so the reducer
 * sees nothing; the distill job's attribution verdicts reach the exporter through
 * `emitAttributions` → `scoreAttributions` as `asset.contribution` scores, which the OTLP sink
 * writes as short `evaluation asset.contribution` spans under the synthetic parent of the case's
 * latest session seed, each carrying one `gen_ai.evaluation.result` span event.
 *
 * Flow (self-boot only; the helpers live in scripts/lib/fakeBoot.mjs):
 *   1. receiver on 127.0.0.1:<any>; scratch home <os.tmpdir()>/argus-otlp-<pid>/home whose
 *      settings enable ONLY the OTLP provider (endpoint = receiver, protocol http/json,
 *      captureContent off) plus distill v3 + attribution on; fx-helped's assets on disk.
 *   2. boot `electron-vite dev` on a free CDP port in 9260-9290; identity gate (exit 2 on a
 *      mismatch: an occupied port is another worktree's app — argus-cdp-port-collision); the
 *      app must report the OTLP settings before anything else happens.
 *   3. health: Settings' "Test connection" path (`health.onResult` + `health.run`) for the
 *      `observability:otlp` row → ok, AND the receiver saw the `argus.probe` span.
 *   4. close fx-helped (distill + attribution) → settle → DB has the verdict rows → the receiver
 *      decodes the two judged assets' evaluation spans: names, slug, score, trace id derived from
 *      the case's latest session seed, the synthetic parent span id, the resource, and (a shape
 *      check only) no message/tool-content key on those spans; captureContent stripping itself
 *      is covered by the sink unit tests, since a fixture close emits no generation/tool spans.
 *   5. negative control: disable the provider through the settings file, wait for the app to
 *      report it AND for the rebuild's shutdown flush to land, then close a copy of fx-helped
 *      under another slug (same judged verdicts — the DB proves scores WOULD have been emitted)
 *      → no request reaches the receiver.
 *
 * Exits 0 when every check passes, 1 when any fails, 2 on an abort (boot / port / identity /
 * settings / fake runner not active).
 */
import { createHash } from 'node:crypto'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { sleep, waitFor, check, report } from './lib/cdp.mjs'
import {
  FIXTURES_DIR,
  loadFixture,
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
import { startOtlpReceiver } from './lib/otlpReceiver.mjs'

const ROOT = path.join(os.tmpdir(), `argus-otlp-${process.pid}`)
const HOME = path.join(ROOT, 'home')
const FAKE_DIR = path.join(HOME, 'fake-runner')
const DB = path.join(HOME, 'argus.db')
const LOG = path.join(ROOT, 'electron.log')
const SETTLE_TIMEOUT_MS = 90_000
/** BatchSpanProcessor's default scheduledDelayMillis is 5 s; give the export room past it. */
const EXPORT_TIMEOUT_MS = 20_000
/** Longer than one batch schedule (5 s): a disabled provider that still exported would land. */
const QUIET_WINDOW_MS = 7_000
const HEALTH_ROW = 'observability:otlp'
const EVAL_SPAN = 'evaluation asset.contribution'
const CONTENT_KEYS = ['gen_ai.input.messages', 'gen_ai.output.messages', 'gen_ai.tool.call.result']
/** shared/attribution.ts SCORE: the value an effective verdict is scored as. */
const SCORE = { helped: 1, neutral: 0, misled: -1 }
const HEX32 = /^[0-9a-f]{32}$/
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

let rx = null
installTeardown(ROOT, () => rx?.close())

const withDb = (fn) => withDbFile(DB, fn)
const settle = (slug) => settleDb(DB, slug, true, SETTLE_TIMEOUT_MS)

/** The OTLP sink's trace id / synthetic parent derivation (sink.ts traceIdFromSeed, langfuse
 *  synthSpanId), restated so the gate checks the wire against the spec, not against itself. */
const sha = (s) => createHash('sha256').update(s).digest('hex')
const nonZero = (hex) => (/^0+$/.test(hex) ? `1${hex.slice(1)}` : hex)
const seedFor = (sessionId) => `argus-session-${sessionId}`
const traceIdFor = (seed) => nonZero(sha(seed).slice(0, 32))
const parentIdFor = (seed) => nonZero(sha(seed).slice(0, 16))

const evalSpansOf = (slug) =>
  rx
    .spans()
    .filter(
      (s) => s.name === EVAL_SPAN && s.events.some((e) => e.attributes['argus.case.slug'] === slug)
    )
const evalEvents = (spans) =>
  spans.flatMap((s) =>
    s.events.filter(
      (e) =>
        e.name === 'gen_ai.evaluation.result' &&
        e.attributes['gen_ai.evaluation.name'] === 'asset.contribution'
    )
  )

/** Seed the fixture's transcript, write its fake stages, close it (distill + attribution) and
 *  settle; the first close must reach the fake within 15 s or the gate aborts. */
async function closeFixture(conn, fx) {
  const caseId = withDb((db) =>
    Number(db.prepare(`SELECT id FROM cases WHERE slug=?`).get(fx.slug).id)
  )
  const ids = withDb((db) => seedFixtureCase(db, caseId, fx))
  writeFakeStages(FAKE_DIR, fx.slug, resolveStages(fx, ids))
  await conn.evalJs(
    `window.argus.cases.setStatus(${JSON.stringify(fx.slug)}, 'closed', ${JSON.stringify(fx.close.resolution)}, true, true)`
  )
  const reached = await waitFor(
    `fake runner call for ${fx.slug}`,
    () => Object.keys(readFakeCalls(FAKE_DIR, fx.slug)).length > 0,
    15_000
  ).catch(() => false)
  if (!reached) {
    for (const j of jobsForDb(DB, fx.slug))
      if (!isTerminal(j))
        await conn.evalJs(`window.argus.distill.cancel(${j.id})`).catch(() => null)
    abort(`FAKE FAIL: no call reached ${FAKE_DIR}/calls.ndjson; the app is not running the fake`)
  }
  await settle(fx.slug)
  return Math.max(...ids.sessionIds)
}

/** The OTLP provider block the app reports (null until the settings read succeeds). */
const otlpSettings = async (conn) =>
  (await conn.evalJs(`window.argus.settings.get()`))?.settings?.observability?.providers?.otlp ??
  null

const main = async () => {
  const t0 = Date.now()
  rx = await startOtlpReceiver({ port: 0 })
  console.error(`OTLP receiver on ${rx.url}`)

  const fxOn = loadFixture(path.join(FIXTURES_DIR, 'fx-helped.json'))
  // The negative control needs a close that WOULD emit scores: the same judged verdicts under
  // another slug / Jira key (the assets on disk are shared; fx-negative judges nothing, so it
  // would emit nothing even with the provider on and could not fail).
  const fxOff = {
    ...structuredClone(fxOn),
    slug: 'fx-otlp-off',
    title: 'Uploader drops batches (fixture: OTLP provider disabled)',
    jiraKey: 'FXO-1'
  }
  const judged = fxOn.expected.attributions.filter((a) => a.verdict !== null)
  const silent = fxOn.expected.attributions.filter((a) => a.verdict === null)

  fs.rmSync(ROOT, { recursive: true, force: true }) // a stale dir from a reused pid
  fs.mkdirSync(FAKE_DIR, { recursive: true }) // the fake refuses a missing dir at boot
  const otlp = { enabled: true, endpoint: rx.url, protocol: 'http/json', captureContent: false }
  mergeSettings(HOME, {
    distill: { pipeline: 'v3', attribution: { default: true } },
    observability: { providers: { otlp } }
  })
  writeFixtureAssets(HOME, fxOn)

  const PORT = await freePort(9260, 9290)
  const bootDeadline = Date.now() + BOOT_TIMEOUT_MS
  await bootFakeApp({ home: HOME, port: PORT, fakeDir: FAKE_DIR, log: LOG, deadline: bootDeadline })
  const conn = await connectRenderer(PORT, bootDeadline)
  console.error(`booted + connected in ${((Date.now() - t0) / 1000).toFixed(1)}s`)

  // ---- identity (argus-cdp-port-collision), BEFORE any write through the app ----
  await identityPrecheck(conn, PORT, DB)
  for (const fx of [fxOn, fxOff])
    await conn.evalJs(
      `window.argus.cases.create(${JSON.stringify({ slug: fx.slug, title: fx.title, jiraKey: fx.jiraKey })})`
    )
  await identityGate(conn, PORT, DB, [fxOn.slug, fxOff.slug])
  check(
    'identity: both fixture cases visible on the connected app AND rows in ARGUS_HOME/argus.db',
    true
  )

  // ---- settings: the file edit reached the app ----
  const s = await waitFor(
    'app reports the OTLP provider + distill v3',
    async () => {
      const st = (await conn.evalJs(`window.argus.settings.get()`))?.settings
      const o = st?.observability?.providers?.otlp
      return st?.distill?.pipeline === 'v3' &&
        st?.distill?.attribution?.default === true &&
        o?.enabled === true &&
        o?.endpoint === rx.url &&
        o?.protocol === 'http/json' &&
        o?.captureContent === false
        ? o
        : null
    },
    20_000
  ).catch(() => null)
  if (!s) abort(`SETTINGS FAIL: the app never reported providers.otlp = ${JSON.stringify(otlp)}`)
  check(
    'settings: app reports providers.otlp enabled → receiver, http/json, captureContent off',
    true
  )

  const preEval = rx.spans().filter((x) => x.name === EVAL_SPAN).length
  console.error(
    `receiver before the probe: ${rx.requests()} request(s), ${rx.spans().length} span(s)`
  )

  // ---- health: the Settings page's Test connection path ----
  const rows = (await conn.evalJs(`window.argus.health.list()`)) ?? []
  check(
    `health: the ${HEALTH_ROW} row is listed`,
    rows.some((r) => r.id === HEALTH_ROW),
    rows.map((r) => r.id)
  )
  await conn.evalJs(`(async () => {
    window.__hr = []
    const off = window.argus.health.onResult((r) => window.__hr.push(r))
    try { await window.argus.health.run([${JSON.stringify(HEALTH_ROW)}]) } finally { setTimeout(off, 5000) }
    return true
  })()`)
  const hr = await waitFor(
    `health result for ${HEALTH_ROW}`,
    () =>
      conn.evalJs(
        `(window.__hr || []).find((r) => r.id === ${JSON.stringify(HEALTH_ROW)}) || null`
      ),
    10_000
  ).catch(() => null)
  check(`health: ${HEALTH_ROW} result is ok`, hr?.ok === true, hr)
  const probe = await waitFor(
    'argus.probe span at the receiver',
    () => rx.spans().find((x) => x.name === 'argus.probe') ?? null,
    10_000
  ).catch(() => null)
  check(
    'health: the receiver got the argus.probe span (the probe went to OUR receiver)',
    Boolean(probe),
    {
      requests: rx.requests(),
      names: rx.spans().map((x) => x.name)
    }
  )
  check(
    'health: the probe span carries resource service.name=argus',
    probe?.resource?.['service.name'] === 'argus',
    probe?.resource
  )

  check(
    'no OTLP request hit a wrong path (only POST /v1/traces is accepted)',
    rx.wrongPath() === 0,
    { count: rx.wrongPath(), lastPath: rx.lastWrongPath() }
  )
  // The probe already satisfies "a request arrived / spans decoded", so the close is asserted
  // against these baselines, not against zero.
  const reqAfterProbe = rx.requests()
  const spansAfterProbe = rx.spans().length

  // ---- close fx-helped: attribution scores → evaluation spans ----
  console.error(`\n--- ${fxOn.slug} (provider ON) ---`)
  check(
    `${fxOn.slug}: no evaluation spans at the receiver before the close`,
    preEval === 0,
    preEval
  )
  const sessionOn = await closeFixture(conn, fxOn)
  const problems = checkExpected(
    withDb((db) => readActual(db, fxOn.slug, readFakeCalls(FAKE_DIR, fxOn.slug))),
    fxOn.expected
  )
  check(
    `${fxOn.slug}: DB matches expected (the verdict rows the scores come from exist)`,
    problems.length === 0,
    problems.length ? problems : undefined
  )
  await waitFor(
    'spans exported',
    () => evalEvents(evalSpansOf(fxOn.slug)).length >= judged.length,
    EXPORT_TIMEOUT_MS
  ).catch(() => null)
  // Non-vacuity first: the CLOSE produced new requests and spans (beyond the probe), and they
  // decoded.
  check(
    'receiver: the close produced new requests (beyond the probe)',
    rx.requests() > reqAfterProbe,
    { afterProbe: reqAfterProbe, now: rx.requests() }
  )
  check(
    'receiver: every request decoded as OTLP/JSON (none undecoded)',
    rx.undecoded() === 0,
    rx.undecoded()
  )
  check(
    'receiver: the close produced new decoded spans (beyond the probe)',
    rx.spans().length > spansAfterProbe,
    { afterProbe: spansAfterProbe, now: rx.spans().length }
  )

  const spans = evalSpansOf(fxOn.slug)
  const events = evalEvents(spans)
  const named = events.map((e) => e.attributes['argus.asset.name']).sort()
  console.error(
    `${fxOn.slug}: ${spans.length} evaluation span(s), events for [${named.join(', ')}]; all spans: ${JSON.stringify(rx.spans().map((x) => x.name))}`
  )
  check(
    `${fxOn.slug}: ≥${judged.length} gen_ai.evaluation.result events named asset.contribution`,
    events.length >= judged.length,
    events.length
  )
  for (const a of judged) {
    const e = events.find((x) => x.attributes['argus.asset.name'] === a.name)
    check(`${fxOn.slug}: an evaluation event names ${a.kind} ${a.name}`, Boolean(e), named)
    check(
      `${fxOn.slug}: ${a.name} carries kind=${a.kind}, score ${SCORE[a.verdict]} (${a.verdict}), a tier`,
      e?.attributes['argus.asset.kind'] === a.kind &&
        e?.attributes['gen_ai.evaluation.score.value'] === SCORE[a.verdict] &&
        typeof e?.attributes['argus.asset.tier'] === 'string',
      e?.attributes
    )
    check(
      `${fxOn.slug}: ${a.name} carries a 32-hex argus.score.id`,
      HEX32.test(String(e?.attributes['argus.score.id'] ?? '')),
      e?.attributes['argus.score.id']
    )
  }
  for (const a of silent)
    check(
      `${fxOn.slug}: the silent (unjudged) ${a.kind} ${a.name} is NOT scored`,
      named.length >= judged.length && !named.includes(a.name),
      named
    )
  check(
    `${fxOn.slug}: every evaluation event carries argus.case.slug=${fxOn.slug}`,
    events.length > 0 && events.every((e) => e.attributes['argus.case.slug'] === fxOn.slug),
    events.map((e) => e.attributes['argus.case.slug'])
  )
  check(
    `${fxOn.slug}: every evaluation span has gen_ai.operation.name=evaluation`,
    spans.length > 0 && spans.every((x) => x.attributes['gen_ai.operation.name'] === 'evaluation'),
    spans.map((x) => x.attributes)
  )

  const all = rx.spans()
  const contentHits = all.flatMap((x) => [
    ...CONTENT_KEYS.filter((k) => k in x.attributes).map((k) => `${x.name}: attr ${k}`),
    ...x.events.flatMap((e) => [
      ...(CONTENT_KEYS.includes(e.name) ? [`${x.name}: event ${e.name}`] : []),
      ...CONTENT_KEYS.filter((k) => k in e.attributes).map((k) => `${x.name}: event attr ${k}`)
    ])
  ])
  // SHAPE check only, not a captureContent test. A seeded fixture close emits only `score`
  // intents (plus the probe), and the OTLP sink writes message / tool-result content solely for
  // `generation` / `tool` intents, so this passes even with captureContent on or the strip
  // removed. Stripping is covered by the sink unit tests until a live-session flow exists.
  check(
    'evaluation/probe spans carry no message/tool-content keys (shape; captureContent stripping is covered by the sink unit tests until a live-session flow exists)',
    all.length > 0 && contentHits.length === 0,
    contentHits.length ? contentHits : `${all.length} spans scanned`
  )
  check(
    'every span traceId is 32 lowercase hex, not all zeros',
    all.length > 0 && all.every((x) => HEX32.test(x.traceId) && !/^0+$/.test(x.traceId)),
    all.filter((x) => !HEX32.test(x.traceId)).map((x) => x.traceId)
  )
  const seed = seedFor(sessionOn)
  const traces = [...new Set(spans.map((x) => x.traceId))]
  check(`${fxOn.slug}: all evaluation spans share one trace id`, traces.length === 1, traces)
  check(
    `${fxOn.slug}: that trace id derives from the latest session's seed (${seed})`,
    traces.length === 1 && traces[0] === traceIdFor(seed),
    { got: traces, want: traceIdFor(seed) }
  )
  check(
    `${fxOn.slug}: evaluation spans hang off the seed's synthetic parent (no live root)`,
    spans.length > 0 && spans.every((x) => x.parentSpanId === parentIdFor(seed)),
    { got: [...new Set(spans.map((x) => x.parentSpanId))], want: parentIdFor(seed) }
  )

  const res = spans[0]?.resource ?? {}
  const installFile = path.join(HOME, 'config', 'instance-id.json')
  const installId = fs.existsSync(installFile)
    ? JSON.parse(fs.readFileSync(installFile, 'utf8')).instanceId
    : null
  check("resource['service.name'] === 'argus'", res['service.name'] === 'argus', res)
  check(
    "resource['argus.install.id'] is a 36-char UUID and THIS home's instance id",
    typeof res['argus.install.id'] === 'string' &&
      res['argus.install.id'].length === 36 &&
      UUID.test(res['argus.install.id']) &&
      res['argus.install.id'] === installId,
    { resource: res['argus.install.id'], home: installId }
  )
  check(
    "resource['service.version'] is set (and matches the events' argus.app.version)",
    typeof res['service.version'] === 'string' &&
      res['service.version'].length > 0 &&
      events.every((e) => e.attributes['argus.app.version'] === res['service.version']),
    res['service.version']
  )

  // ---- negative control: a disabled provider exports nothing ----
  console.error(`\n--- ${fxOff.slug} (provider OFF) ---`)
  mergeSettings(HOME, { observability: { providers: { otlp: { enabled: false } } } })
  const off = await waitFor(
    'app reports providers.otlp.enabled=false',
    async () => ((await otlpSettings(conn))?.enabled === false ? true : null),
    20_000
  ).catch(() => false)
  check('negative: app reports providers.otlp.enabled=false', off)
  // The disable rebuilt the exporter and SHUT DOWN the old sink, which flushes: let that land,
  // then take the baseline.
  await sleep(QUIET_WINDOW_MS)
  const before = rx.requests()
  console.error(`negative: baseline ${before} request(s) after the rebuild settled`)
  await closeFixture(conn, fxOff)
  const offRows = withDb((db) => readActual(db, fxOff.slug, {}).rows)
  check(
    `negative: ${fxOff.slug} wrote ${judged.length} judged verdict rows (scores WOULD be emitted)`,
    offRows.filter((r) => r.verdict !== null).length === judged.length,
    offRows.map((r) => `${r.name}:${r.verdict}`)
  )
  await sleep(QUIET_WINDOW_MS)
  check(
    `negative: no request reached the receiver within ${QUIET_WINDOW_MS / 1000}s of the close`,
    rx.requests() === before,
    { before, after: rx.requests() }
  )
  check(
    `negative: no span for ${fxOff.slug} at the receiver`,
    evalSpansOf(fxOff.slug).length === 0,
    evalSpansOf(fxOff.slug).length
  )

  console.error(`\ngate took ${((Date.now() - t0) / 1000).toFixed(1)}s`)
  conn.close()
  await rx.close()
  rx = null
  report()
}

main().catch((e) => {
  console.error('GATE ERROR', e)
  process.exit(1)
})
