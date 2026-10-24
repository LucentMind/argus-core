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
 *   5. the same close's distill job: its `invoke_agent distill <slug>` root in the trace derived
 *      from `argus-distill-job-<id>@<finished_at>` (job facts as `argus.*` attributes), ≥4 `stage <key>`
 *      generation spans under it (usage + model, dossier before materialize), no fixture stage
 *      text anywhere in the trace (captureContent off); then accept one staged proposal and
 *      reject another as `duplicate` (no attribution override) → two `proposal.outcome`
 *      evaluation events on that job trace (value, outcome, edited / reason + note, job id,
 *      score id recomputed from the install id and the proposal file).
 *   6. negative control: disable the provider through the settings file, wait for the app to
 *      report it AND for the rebuild's shutdown flush to land, then close a copy of fx-helped
 *      under another slug (same judged verdicts — the DB proves scores WOULD have been emitted)
 *      → no request reaches the receiver.
 *
 * Exits 0 when every check passes, 1 when any fails, 2 on an abort (boot / port / identity /
 * settings / fake runner not active).
 */
import { createHash, randomBytes } from 'node:crypto'
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

  // ---- distill-job trace (spec 2026-10-24 distillation-health) ----
  // One trace per finished distill job: an `invoke_agent distill <slug>` root (job facts as
  // `argus.<camelCase>` attributes), one `chat <model>` generation per stage (named by
  // `argus.span.name = 'stage <key>'`), parented to the root.
  console.error(`\n--- ${fxOn.slug}: distill job trace ---`)
  const job = jobsForDb(DB, fxOn.slug).find((j) => j.kind === 'case' && j.state === 'done')
  check(`${fxOn.slug}: a done case job exists`, Boolean(job), jobsForDb(DB, fxOn.slug))
  const jobId = job?.id ?? -1
  // One trace per ATTEMPT: the seed carries the row's finished_at (a retry of the same row id is
  // a new trace). Read it from the DB — the independent oracle — not from the span.
  const finishedAt = withDb(
    (db) => db.prepare(`SELECT finished_at FROM distill_jobs WHERE id = ?`).get(jobId)?.finished_at
  )
  check(`${fxOn.slug}: the done job has a finished_at`, typeof finishedAt === 'string', finishedAt)
  const jobSeed = finishedAt
    ? `argus-distill-job-${jobId}@${finishedAt}`
    : `argus-distill-job-${jobId}`
  const jobTrace = traceIdFor(jobSeed)
  const rootName = `invoke_agent distill ${fxOn.slug}`
  await waitFor(
    'distill root span exported',
    () => rx.spans().some((x) => x.traceId === jobTrace && x.name === rootName),
    EXPORT_TIMEOUT_MS
  ).catch(() => null)
  const jobSpans = rx.spans().filter((x) => x.traceId === jobTrace)
  const root = jobSpans.find((x) => x.name === rootName)
  const ra = root?.attributes ?? {}
  check(`${fxOn.slug}: root '${rootName}' in trace sha256(${jobSeed})[0:32]`, Boolean(root), {
    want: jobTrace,
    inTrace: jobSpans.map((x) => x.name)
  })
  check(
    `${fxOn.slug}: the root hangs off the job seed's synthetic parent`,
    Boolean(root) && root.parentSpanId === parentIdFor(jobSeed),
    { got: root?.parentSpanId, want: parentIdFor(jobSeed) }
  )
  check(
    `${fxOn.slug}: root carries argus.kind=case, argus.state=done, argus.pipeline=v3, argus.jobId=${jobId}`,
    ra['argus.kind'] === 'case' &&
      ra['argus.state'] === 'done' &&
      ra['argus.pipeline'] === 'v3' &&
      jobId > 0 &&
      ra['argus.jobId'] === jobId,
    ra
  )
  check(
    `${fxOn.slug}: root carries argus.costUsd > 0 and argus.caseDomain=FXH`,
    typeof ra['argus.costUsd'] === 'number' &&
      ra['argus.costUsd'] > 0 &&
      ra['argus.caseDomain'] === 'FXH',
    { costUsd: ra['argus.costUsd'], caseDomain: ra['argus.caseDomain'] }
  )
  const stageName = (x) => x.attributes['argus.span.name']
  const stageSpans = jobSpans.filter(
    (x) => typeof stageName(x) === 'string' && stageName(x).startsWith('stage ')
  )
  check(
    `${fxOn.slug}: ≥4 stage spans, every one parented to the root`,
    Boolean(root) &&
      stageSpans.length >= 4 &&
      stageSpans.every((x) => x.parentSpanId === root.spanId),
    stageSpans.map((x) => [stageName(x), x.parentSpanId])
  )
  check(
    `${fxOn.slug}: every stage span carries numeric gen_ai.usage.input_tokens and a string gen_ai.request.model`,
    stageSpans.length >= 4 &&
      stageSpans.every(
        (x) =>
          typeof x.attributes['gen_ai.usage.input_tokens'] === 'number' &&
          typeof x.attributes['gen_ai.request.model'] === 'string' &&
          x.attributes['gen_ai.request.model'].length > 0
      ),
    stageSpans.map((x) => [
      stageName(x),
      x.attributes['gen_ai.usage.input_tokens'],
      x.attributes['gen_ai.request.model']
    ])
  )
  const dossierSpan = stageSpans.find((x) => stageName(x) === 'stage dossier')
  const materializeSpan = stageSpans.find((x) => stageName(x).startsWith('stage materialize '))
  const nanos = (v) => (/^\d+$/.test(String(v ?? '')) ? BigInt(v) : null)
  // Independent oracle: the job row's own stages_json (read straight from the DB, not via the
  // telemetry code). `reconstructTimes` makes dossier.end <= materialize.start true no matter what
  // the sink does, so the ordering below is DERIVED. The load-bearing check is the per-stage
  // duration: end - start on the wire must equal usage.durationMs * 1e6 from stages_json, which
  // only holds if the sink honours the intent's startTime/endTime (a sink stamping wall-clock
  // `now` would give ~0 or a wrong width). The fake runner gives agent stages (dossier) 100 ms and
  // one-shot stages 10 ms, so the widths differ per stage and are not all zero.
  const jobRow = withDb((db) =>
    db.prepare(`SELECT stages_json, duration_ms FROM distill_jobs WHERE id=?`).get(jobId)
  )
  let stagesOracle = null
  try {
    stagesOracle = JSON.parse(jobRow?.stages_json ?? 'null')
  } catch {
    stagesOracle = null
  }
  const oracleDur = new Map()
  if (stagesOracle && typeof stagesOracle === 'object') {
    for (const k of ['dossier', 'summary', 'candidates', 'attribution'])
      if (stagesOracle[k]) oracleDur.set(k, stagesOracle[k].usage?.durationMs ?? 0)
    for (const m of Array.isArray(stagesOracle.materialize) ? stagesOracle.materialize : [])
      oracleDur.set(`materialize ${m.type} ${m.target}`, m.usage?.durationMs ?? 0)
  }
  const durationRows = stageSpans.map((x) => {
    const key = stageName(x).slice('stage '.length)
    const s = nanos(x.startTimeUnixNano)
    const e = nanos(x.endTimeUnixNano)
    const want = oracleDur.has(key) ? BigInt(oracleDur.get(key)) * 1_000_000n : null
    return { key, width: s !== null && e !== null ? e - s : null, want }
  })
  check(
    `${fxOn.slug}: every stage span's end-start equals its stages_json usage.durationMs * 1e6 (sink honours intent times; widths ${[...new Set(durationRows.map((r) => String(r.want)))].join('/')} ns)`,
    stageSpans.length >= 4 &&
      oracleDur.size === stageSpans.length &&
      durationRows.every((r) => r.want !== null && r.width === r.want) &&
      new Set(durationRows.map((r) => r.want)).size >= 2,
    durationRows.map((r) => [r.key, String(r.width), String(r.want)])
  )
  check(
    `${fxOn.slug}: stage spans are ordered in time (dossier ends before materialize starts; derived from reconstructTimes)`,
    Boolean(dossierSpan && materializeSpan) &&
      nanos(dossierSpan.endTimeUnixNano) !== null &&
      nanos(materializeSpan.startTimeUnixNano) !== null &&
      nanos(dossierSpan.endTimeUnixNano) <= nanos(materializeSpan.startTimeUnixNano),
    stageSpans.map((x) => [stageName(x), x.startTimeUnixNano, x.endTimeUnixNano])
  )
  // captureContent is OFF: no fixture stage text anywhere in this trace. The scan collects every
  // string in the spans and descends into any string that is itself JSON (the sink JSON-encodes
  // message content), so a quoted / escaped copy of the text is found too — a plain
  // `JSON.stringify(spans).includes(marker)` would miss it (the markers contain `"` and `\n`).
  //
  // Two marker sets: the first 40 chars of each stage text (whole-text copies), plus SHORT interior
  // fragments (every run of 3 consecutive words, 12-24 chars, letters/spaces/hyphens). The
  // fragments exist because a parser error quotes only a few chars of its input (V8's JSON.parse:
  // `Unexpected token '`'`, "```json\n{"... is not valid JSON), which a 40-char prefix never
  // matches. NOTE: the ERROR-string redaction path itself (scrubError) is covered by
  // distillTelemetry.test.ts; this fixture has no failing stage, so no `error` attribute is
  // exercised here and the fragments mainly guard the other string-bearing attributes.
  const stageTexts = Object.values(fxOn.stages)
    .map((st) => st?.text)
    .filter((t) => typeof t === 'string')
  const prefixMarkers = stageTexts.filter((t) => t.length >= 40).map((t) => t.slice(0, 40))
  const fragmentMarkers = (() => {
    const out = new Set()
    for (const t of stageTexts) {
      const words = t.split(/\s+/).filter(Boolean)
      for (let i = 0; i + 3 <= words.length; i++) {
        const frag = words.slice(i, i + 3).join(' ')
        if (frag.length >= 12 && frag.length <= 24 && /^[A-Za-z][A-Za-z -]*$/.test(frag))
          out.add(frag)
      }
    }
    return [...out]
  })()
  const rawMarkers = [...new Set([...prefixMarkers, ...fragmentMarkers])]
  const stringsIn = (v, out = []) => {
    if (typeof v === 'string') {
      out.push(v)
      if (/^\s*[[{]/.test(v)) {
        try {
          stringsIn(JSON.parse(v), out)
        } catch {
          // not JSON: the raw string is already collected
        }
      }
    } else if (v && typeof v === 'object') for (const x of Object.values(v)) stringsIn(x, out)
    return out
  }
  const leaks = (spansToScan, markers = rawMarkers) => {
    const all = stringsIn(spansToScan)
    return markers.filter((m) => all.some((x) => x.includes(m)))
  }
  // Scanner non-vacuity: a marker that is unique by construction, JSON-encoded the way the sink
  // encodes captureContent-on output, is caught exactly once (and nothing else is).
  const plantedMarker = `PLANTED-LEAK-${randomBytes(6).toString('hex')}`
  const planted = [
    {
      events: [
        {
          attributes: {
            'gen_ai.output.messages': JSON.stringify([
              { role: 'assistant', parts: [{ type: 'text', content: `x ${plantedMarker} y` }] }
            ])
          }
        }
      ]
    }
  ]
  const plantedHits = leaks(planted, [...rawMarkers, plantedMarker])
  check(
    `${fxOn.slug}: the raw-text scanner catches a planted unique marker exactly once (${prefixMarkers.length} prefix + ${fragmentMarkers.length} fragment markers)`,
    prefixMarkers.length >= 4 &&
      fragmentMarkers.length >= 4 &&
      plantedHits.length === 1 &&
      plantedHits[0] === plantedMarker,
    { prefixes: prefixMarkers.length, fragments: fragmentMarkers.length, hits: plantedHits }
  )
  check(
    `${fxOn.slug}: no stage raw text anywhere in the job trace (captureContent off)`,
    jobSpans.length > stageSpans.length && stageSpans.length >= 4 && leaks(jobSpans).length === 0,
    { scanned: jobSpans.length, leaked: leaks(jobSpans) }
  )

  // ---- proposal outcomes: proposal.outcome scores on the job trace ----
  console.error(`\n--- ${fxOn.slug}: proposal outcomes ---`)
  const pendingFor = async (slug) =>
    ((await conn.evalJs(`window.argus.proposals.list()`))?.proposals ?? []).filter(
      (p) => p.caseSlug === slug
    )
  const pending = await pendingFor(fxOn.slug)
  check(
    `${fxOn.slug}: ≥2 staged proposals to decide`,
    pending.length >= 2,
    pending.map((p) => `${p.type} ${p.target} (job ${p.jobId})`)
  )
  const toAccept = pending.find((p) => p.type === 'case-summary') ?? pending[0]
  const toReject = pending.find((p) => p !== toAccept)
  const REJECT_NOTE = 'gate: duplicate of the installed skill'
  if (toAccept && toReject) {
    await conn.evalJs(`window.argus.proposals.accept(${JSON.stringify(toAccept.file)})`)
    // `duplicate` carries no attribution override (wrong/overfit do), so the attribution
    // checks above and the negative control's verdict rows stay valid.
    await conn.evalJs(
      `window.argus.proposals.reject(${JSON.stringify(toReject.file)}, ${JSON.stringify({ tag: 'duplicate', note: REJECT_NOTE })})`
    )
  }
  const stillPending = (await pendingFor(fxOn.slug)).map((p) => p.file)
  check(
    `${fxOn.slug}: both decisions landed (neither file is pending any more)`,
    Boolean(toAccept && toReject) &&
      !stillPending.includes(toAccept.file) &&
      !stillPending.includes(toReject.file),
    { accept: toAccept?.file, reject: toReject?.file, stillPending }
  )
  const outcomeEvents = () =>
    rx
      .spans()
      .filter((x) => x.traceId === jobTrace)
      .flatMap((x) =>
        x.events
          .filter(
            (e) =>
              e.name === 'gen_ai.evaluation.result' &&
              e.attributes['gen_ai.evaluation.name'] === 'proposal.outcome'
          )
          .map((e) => ({ span: x, e }))
      )
  await waitFor(
    'two proposal.outcome evaluation events',
    () => outcomeEvents().length >= 2,
    EXPORT_TIMEOUT_MS
  ).catch(() => null)
  const outcomes = outcomeEvents()
  check(
    `${fxOn.slug}: exactly two proposal.outcome events on the job trace`,
    outcomes.length === 2,
    outcomes.map(({ e }) => e.attributes)
  )
  check(
    `${fxOn.slug}: the outcome spans are 'evaluation proposal.outcome' children of the job root`,
    Boolean(root) &&
      outcomes.length === 2 &&
      outcomes.every(
        ({ span }) =>
          span.name === 'evaluation proposal.outcome' && span.parentSpanId === root.spanId
      ),
    outcomes.map(({ span }) => [span.name, span.parentSpanId])
  )
  const outcomeFor = (p) =>
    p
      ? outcomes.find(
          ({ e }) =>
            e.attributes['argus.proposal.target'] === p.target &&
            e.attributes['argus.proposal.type'] === p.type
        )?.e.attributes
      : undefined
  const acc = outcomeFor(toAccept)
  const rej = outcomeFor(toReject)
  check(
    `${fxOn.slug}: accepted ${toAccept?.type} → value 1, outcome=accepted, edited=false`,
    acc?.['gen_ai.evaluation.score.value'] === 1 &&
      acc?.['argus.proposal.outcome'] === 'accepted' &&
      acc?.['argus.proposal.edited'] === false,
    acc
  )
  check(
    `${fxOn.slug}: rejected ${toReject?.type} → value 0, outcome=rejected, reject_reason=duplicate, explanation = the note`,
    rej?.['gen_ai.evaluation.score.value'] === 0 &&
      rej?.['argus.proposal.outcome'] === 'rejected' &&
      rej?.['argus.proposal.reject_reason'] === 'duplicate' &&
      rej?.['gen_ai.evaluation.explanation'] === REJECT_NOTE,
    rej
  )
  check(
    `${fxOn.slug}: both outcomes carry argus.job.id=${jobId} and a 32-hex argus.score.id`,
    outcomes.length === 2 &&
      outcomes.every(
        ({ e }) =>
          e.attributes['argus.job.id'] === jobId &&
          HEX32.test(String(e.attributes['argus.score.id'] ?? ''))
      ),
    outcomes.map(({ e }) => [e.attributes['argus.job.id'], e.attributes['argus.score.id']])
  )
  check(
    `${fxOn.slug}: each argus.score.id = sha256(installId|proposal file|date)[0:32] (recomputed here)`,
    Boolean(acc && rej && installId && toAccept.date && toReject.date) &&
      acc['argus.score.id'] ===
        sha(`${installId}|${toAccept.file}|${toAccept.date}`).slice(0, 32) &&
      rej['argus.score.id'] === sha(`${installId}|${toReject.file}|${toReject.date}`).slice(0, 32),
    { accept: acc?.['argus.score.id'], reject: rej?.['argus.score.id'], installId }
  )
  check(
    `${fxOn.slug}: the two score ids differ (one per proposal file)`,
    outcomes.length === 2 &&
      new Set(outcomes.map(({ e }) => e.attributes['argus.score.id'])).size === 2,
    outcomes.map(({ e }) => e.attributes['argus.score.id'])
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
