#!/usr/bin/env node
/**
 * Credential-free Datadog LLM Observability gate. Drives the REAL app over CDP with the headless
 * runners replaced by the fixture-driven fake (src/main/services/distill/fakeRunner.ts) and the
 * Datadog provider enabled ONLY by an org policy file (`ARGUS_POLICY_FILE`) whose `intakeUrl`
 * points at a local fake intake (scripts/lib/datadogReceiver.mjs). Nothing in settings.json
 * enables it, so this exercises the policy path end to end: load, merge, key resolution, the
 * locked Settings UI, the main-process lock, hot reload (key rotation) and removal.
 *
 * Flow (self-boot only; helpers in scripts/lib/fakeBoot.mjs):
 *   1. receiver on 127.0.0.1:<any> accepting key-1; scratch home with distill v3 + attribution on
 *      and NO observability settings; a policy file enabling Datadog (intakeUrl = receiver,
 *      captureContent off, env gate, mlApp argus-gate, apiKey key-1).
 *   2. boot; identity gate; the app reports the policy as managing datadog, the key never
 *      reaches the renderer, and the user's own datadog settings are untouched (still off).
 *   3. lock: a settings patch to a locked key and a secret write to the policy key are refused
 *      by main; Settings → Observability shows the Datadog section managed (badge, disabled
 *      Enable switch checked, disabled site / ML app / API key) and Test connection enabled.
 *   4. health: `observability:datadog` ok via GET /api/v1/validate with key-1; `policy` row ok.
 *   5. close fx-helped → the judged assets' `asset_contribution` evaluations arrive, trace-scoped,
 *      joined to the latest session seed's root ids, tagged with case slug, asset name and a
 *      32-hex `argus.score.id`; the distill job's `agent` root and ≥4 `llm` stage spans arrive
 *      in the job seed's trace; every payload carries ml_app + service/version/install/env tags;
 *      no fixture stage text anywhere (captureContent off).
 *   6. rotation: rewrite the policy with key-2 and revoke key-1 at the receiver; without a
 *      restart the health row is ok again and the receiver saw key-2.
 *   7. removal: delete the policy file → the app reports no policy, the datadog row is gone,
 *      and closing a copy of fx-helped sends nothing.
 *
 * Exits 0 when every check passes, 1 when any fails, 2 on an abort.
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
import { startDatadogReceiver } from './lib/datadogReceiver.mjs'

const ROOT = path.join(os.tmpdir(), `argus-dd-${process.pid}`)
const HOME = path.join(ROOT, 'home')
const FAKE_DIR = path.join(HOME, 'fake-runner')
const DB = path.join(HOME, 'argus.db')
const LOG = path.join(ROOT, 'electron.log')
const POLICY = path.join(ROOT, 'policy', 'policy.json')
const SETTLE_TIMEOUT_MS = 90_000
/** The sink flushes every 5 s; give the export room past it. */
const EXPORT_TIMEOUT_MS = 20_000
/** Longer than one flush interval: a sink that still exported would land. */
const QUIET_WINDOW_MS = 7_000
/** The policy file is polled every 2 s. */
const POLICY_RELOAD_MS = 15_000
const HEALTH_ROW = 'observability:datadog'
const KEY1 = 'gate-key-1-0123456789abcdef'
const KEY2 = 'gate-key-2-fedcba9876543210'
const ML_APP = 'argus-gate'
const LABEL = 'Datadog LLM Observability'
/** shared/attribution.ts SCORE: the value an effective verdict is scored as. */
const SCORE = { helped: 1, neutral: 0, misled: -1 }
const HEX32 = /^[0-9a-f]{32}$/
const DEC = /^[1-9][0-9]*$/

let rx = null
installTeardown(ROOT, () => rx?.close())

const withDb = (fn) => withDbFile(DB, fn)
const settle = (slug) => settleDb(DB, slug, true, SETTLE_TIMEOUT_MS)

/** The adapter's id derivation (sink.ts), restated so the gate checks the wire against the
 *  spec, not against itself. */
const sha = (s) => createHash('sha256').update(s).digest('hex')
const nonZero = (hex) => (/^0+$/.test(hex) ? `1${hex.slice(1)}` : hex)
const traceIdFor = (seed) => nonZero(sha(seed).slice(0, 32))
const rootIdFor = (seed) => {
  const n = BigInt(`0x${nonZero(sha(seed).slice(0, 16))}`) & 0x7fffffffffffffffn
  return (n === 0n ? 1n : n).toString()
}
const readInstallId = () => {
  const f = path.join(HOME, 'config', 'instance-id.json')
  return fs.existsSync(f) ? JSON.parse(fs.readFileSync(f, 'utf8')).instanceId : null
}
const seedFor = (installId, sessionId) => `argus-session-${sessionId}@${installId}`
const tagOf = (tags, key) =>
  (tags ?? []).find((t) => t.startsWith(`${key}:`))?.slice(key.length + 1)

const writePolicy = (block) => {
  fs.mkdirSync(path.dirname(POLICY), { recursive: true })
  const tmp = `${POLICY}.tmp`
  fs.writeFileSync(tmp, JSON.stringify({ observability: { providers: { datadog: block } } }))
  fs.renameSync(tmp, POLICY)
}

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

/** Run one health row the way Settings' Test connection does; null when nothing arrives. */
async function runHealth(conn, id) {
  const slot = `__hr_${id.replace(/\W/g, '_')}_${Date.now()}`
  await conn.evalJs(`(async () => {
    window.${slot} = []
    const off = window.argus.health.onResult((r) => window.${slot}.push(r))
    try { await window.argus.health.run([${JSON.stringify(id)}]) } finally { setTimeout(off, 5000) }
    return true
  })()`)
  return waitFor(
    `health result for ${id}`,
    () => conn.evalJs(`(window.${slot} || []).find((r) => r.id === ${JSON.stringify(id)}) || null`),
    10_000
  ).catch(() => null)
}

const main = async () => {
  const t0 = Date.now()
  rx = await startDatadogReceiver({ port: 0, keys: [KEY1] })
  console.error(`Datadog receiver on ${rx.url}`)

  const fxOn = loadFixture(path.join(FIXTURES_DIR, 'fx-helped.json'))
  const fxOff = {
    ...structuredClone(fxOn),
    slug: 'fx-dd-off',
    title: 'Uploader drops batches (fixture: Datadog policy removed)',
    jiraKey: 'FXD-1'
  }
  const judged = fxOn.expected.attributions.filter((a) => a.verdict !== null)
  const silent = fxOn.expected.attributions.filter((a) => a.verdict === null)

  fs.rmSync(ROOT, { recursive: true, force: true })
  fs.mkdirSync(FAKE_DIR, { recursive: true })
  mergeSettings(HOME, { distill: { pipeline: 'v3', attribution: { default: true } } })
  writeFixtureAssets(HOME, fxOn)
  const block1 = {
    enabled: true,
    site: 'datadoghq.eu',
    mlApp: ML_APP,
    env: 'gate',
    captureContent: false,
    apiKey: KEY1,
    intakeUrl: rx.url
  }
  writePolicy(block1)

  const PORT = await freePort(9260, 9290)
  const bootDeadline = Date.now() + BOOT_TIMEOUT_MS
  await bootFakeApp({
    home: HOME,
    port: PORT,
    fakeDir: FAKE_DIR,
    log: LOG,
    deadline: bootDeadline,
    extraEnv: { ARGUS_POLICY_FILE: POLICY }
  })
  const conn = await connectRenderer(PORT, bootDeadline)
  console.error(`booted + connected in ${((Date.now() - t0) / 1000).toFixed(1)}s`)

  await identityPrecheck(conn, PORT, DB)
  for (const fx of [fxOn, fxOff])
    await conn.evalJs(
      `window.argus.cases.create(${JSON.stringify({ slug: fx.slug, title: fx.title, jiraKey: fx.jiraKey })})`
    )
  await identityGate(conn, PORT, DB, [fxOn.slug, fxOff.slug])
  check('identity: both fixture cases visible on the connected app AND in ARGUS_HOME', true)

  // ---- policy: loaded, merged, key kept in main ----
  const pol = await waitFor(
    'app reports the policy managing datadog',
    async () => {
      const p = await conn.evalJs(`window.argus.policy.get()`)
      return p?.present && p.observability?.datadog ? p : null
    },
    20_000
  ).catch(() => null)
  if (!pol) abort('POLICY FAIL: the app never reported a policy managing datadog')
  check(
    'policy: present, no errors, datadog managed with the file values',
    pol.errors.length === 0 &&
      pol.observability.datadog.values.enabled === true &&
      pol.observability.datadog.values.site === 'datadoghq.eu' &&
      pol.observability.datadog.values.mlApp === ML_APP &&
      pol.observability.datadog.customIntake === true,
    pol
  )
  check(
    'policy: the renderer payload carries neither the API key nor the intake URL',
    !JSON.stringify(pol).includes(KEY1) && !JSON.stringify(pol).includes(rx.url),
    pol
  )
  const userDd = (await conn.evalJs(`window.argus.settings.get()`))?.settings?.observability
    ?.providers?.datadog
  check(
    "policy: the user's own datadog settings are untouched (still off, nothing written)",
    userDd?.enabled === false,
    userDd
  )
  const settingsFile = path.join(HOME, 'config', 'settings.json')
  check(
    'policy: neither settings.json nor secrets.json contains the key',
    ![settingsFile, path.join(HOME, 'config', 'secrets.json')].some(
      (f) => fs.existsSync(f) && fs.readFileSync(f, 'utf8').includes(KEY1)
    )
  )

  // ---- lock: main refuses writes to managed keys ----
  const patchErr = await conn.evalJs(
    `window.argus.settings.patch({ observability: { providers: { datadog: { enabled: false } } } }).then(() => null, (e) => String(e && e.message || e))`
  )
  check(
    'lock: a settings patch to a locked key is refused by main',
    typeof patchErr === 'string' && /managed by your organization/.test(patchErr),
    patchErr
  )
  const secretErr = await conn.evalJs(
    `window.argus.secrets.set('observability/datadog/api-key', 'user-key').then(() => null, (e) => String(e && e.message || e))`
  )
  check(
    'lock: a secret write to the policy-supplied key is refused by main',
    typeof secretErr === 'string' && /managed by your organization/.test(secretErr),
    secretErr
  )
  const okPatch = await conn.evalJs(
    `window.argus.settings.patch({ observability: { providers: { otlp: { captureContent: false } } } }).then(() => 'ok', (e) => String(e))`
  )
  check('lock: an unmanaged provider stays writable', okPatch === 'ok', okPatch)

  // ---- UI: Settings → Observability shows the section managed ----
  await conn.evalJs(`(() => {
    const b = [...document.querySelectorAll('button')].find((x) => x.textContent.trim() === 'Skip setup')
    if (b) b.click()
  })()`)
  await sleep(400)
  const navTo = (label) =>
    conn.evalJs(`(() => {
      const b = [...document.querySelectorAll('button')].find((x) => x.textContent.trim() === ${JSON.stringify(label)})
      if (!b) return false
      b.click()
      return true
    })()`)
  if (!(await navTo('Observability'))) {
    await conn.evalJs(`document.querySelector('[aria-label="Settings"]')?.click()`)
    await sleep(400)
  }
  await waitFor('the Observability page', () => navTo('Observability'), 10_000).catch(() => null)
  const ui = await waitFor(
    'the managed Datadog section',
    () =>
      conn.evalJs(`(() => {
        const q = (l) => document.querySelector('[aria-label=' + JSON.stringify(l) + ']')
        const enable = q('Enable ${LABEL}')
        const badge = q('${LABEL} is managed')
        if (!enable || !badge) return null
        let card = enable
        while (card && ![...card.querySelectorAll('button')].some((b) => b.textContent.trim() === 'Test connection')) card = card.parentElement
        const test = card && [...card.querySelectorAll('button')].find((b) => b.textContent.trim() === 'Test connection')
        const all = [...document.querySelectorAll('[aria-label^="Enable "][role="switch"]')].map((x) => x.getAttribute('aria-label'))
        return {
          badge: badge.textContent.trim(),
          enableDisabled: enable.disabled,
          enableChecked: enable.getAttribute('aria-checked'),
          site: q('${LABEL} Site')?.disabled,
          siteText: q('${LABEL} Site')?.textContent.trim(),
          mlApp: q('${LABEL} ML app')?.disabled,
          mlAppValue: q('${LABEL} ML app')?.value,
          apiKey: q('${LABEL} API key')?.disabled,
          capture: q('Capture content · ${LABEL}')?.disabled,
          summary: document.querySelector('[data-testid="policy-summary-datadog"]')?.textContent,
          testEnabled: Boolean(test) && !test.disabled,
          firstProvider: all.find((l) => /Datadog|Langfuse|OpenTelemetry/.test(l)),
          hScroll: document.scrollingElement.scrollWidth > document.scrollingElement.clientWidth
        }
      })()`),
    15_000
  ).catch(() => null)
  check(
    'ui: the Datadog section shows "Managed by your organization"',
    ui?.badge === 'Managed by your organization',
    ui
  )
  check(
    'ui: Enable is disabled and on; site, ML app, API key and capture content are disabled',
    ui?.enableDisabled === true &&
      ui.enableChecked === 'true' &&
      ui.site === true &&
      ui.siteText === 'datadoghq.eu' &&
      ui.mlApp === true &&
      ui.mlAppValue === ML_APP &&
      ui.apiKey === true &&
      ui.capture === true,
    ui
  )
  check(
    'ui: Datadog is the first provider section',
    ui?.firstProvider === `Enable ${LABEL}`,
    ui?.firstProvider
  )
  check(
    'ui: the summary says what is sent; Test connection stays available; no horizontal scroll',
    /no prompts, responses or tool output/.test(ui?.summary ?? '') &&
      ui.testEnabled === true &&
      ui.hScroll === false,
    ui
  )

  // ---- health ----
  const rows = (await conn.evalJs(`window.argus.health.list()`)) ?? []
  check(
    `health: the ${HEALTH_ROW} and policy rows are listed`,
    rows.some((r) => r.id === HEALTH_ROW) && rows.some((r) => r.id === 'policy'),
    rows.map((r) => r.id)
  )
  const validatesBefore = rx.validates()
  const hr = await runHealth(conn, HEALTH_ROW)
  check(`health: ${HEALTH_ROW} ok (authenticated · datadoghq.eu)`, hr?.ok === true, hr)
  check(
    'health: the probe hit OUR receiver with the policy key',
    rx.validates() > validatesBefore && rx.keysSeen().at(-1) === KEY1,
    { validates: rx.validates(), lastKey: rx.keysSeen().at(-1) }
  )
  const pr = await runHealth(conn, 'policy')
  check('health: the policy row is ok', pr?.ok === true, pr)

  // ---- close fx-helped: evaluations + distill job trace ----
  console.error(`\n--- ${fxOn.slug} (policy ON) ---`)
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
  const contribs = () =>
    rx
      .evals()
      .filter(
        (e) => e.label === 'asset_contribution' && tagOf(e.tags, 'argus.case.slug') === fxOn.slug
      )
  await waitFor(
    'asset_contribution evaluations',
    () => contribs().length >= judged.length,
    EXPORT_TIMEOUT_MS
  ).catch(() => null)
  const evs = contribs()
  const named = evs.map((e) => tagOf(e.tags, 'argus.asset.name')).sort()
  console.error(`${fxOn.slug}: ${evs.length} evaluation(s) for [${named.join(', ')}]`)
  check(
    `${fxOn.slug}: ≥${judged.length} asset_contribution evaluations`,
    evs.length >= judged.length,
    evs.length
  )
  for (const a of judged) {
    const e = evs.find((x) => tagOf(x.tags, 'argus.asset.name') === a.name)
    check(
      `${fxOn.slug}: ${a.name} → score ${SCORE[a.verdict]} (${a.verdict}), kind ${a.kind}, 32-hex score id`,
      e?.metric_type === 'score' &&
        e.score_value === SCORE[a.verdict] &&
        tagOf(e.tags, 'argus.asset.kind') === a.kind &&
        HEX32.test(tagOf(e.tags, 'argus.score.id') ?? ''),
      e
    )
  }
  for (const a of silent)
    check(`${fxOn.slug}: the silent ${a.name} is NOT scored`, !named.includes(a.name), named)
  const installId = readInstallId()
  const seed = seedFor(installId, sessionOn)
  check(
    `${fxOn.slug}: every evaluation is trace-scoped and joined to the seed's root (${seed})`,
    evs.length > 0 &&
      evs.every(
        (e) =>
          e.eval_scope === 'trace' &&
          e.ml_app === ML_APP &&
          e.join_on?.span?.trace_id === traceIdFor(seed) &&
          e.join_on?.span?.span_id === rootIdFor(seed) &&
          DEC.test(e.join_on.span.span_id) &&
          Number.isInteger(e.timestamp_ms)
      ),
    { got: evs.map((e) => e.join_on), want: { trace: traceIdFor(seed), span: rootIdFor(seed) } }
  )
  check(
    `${fxOn.slug}: every evaluation carries service/version/install/env tags`,
    evs.length > 0 &&
      evs.every(
        (e) =>
          tagOf(e.tags, 'service') === 'argus' &&
          (tagOf(e.tags, 'version') ?? '').length > 0 &&
          tagOf(e.tags, 'argus.install_id') === installId &&
          tagOf(e.tags, 'env') === 'gate'
      ),
    evs[0]?.tags
  )

  // The distill job's trace: agent root + llm stage spans, in the job seed's trace.
  const job = jobsForDb(DB, fxOn.slug).find((j) => j.kind === 'case' && j.state === 'done')
  const finishedAt = withDb(
    (db) =>
      db.prepare(`SELECT finished_at FROM distill_jobs WHERE id = ?`).get(job?.id ?? -1)
        ?.finished_at
  )
  const jobSeed = finishedAt
    ? `argus-distill-job-${job?.id}@${finishedAt}`
    : `argus-distill-job-${job?.id}`
  const jobTrace = traceIdFor(jobSeed)
  await waitFor(
    'distill root span',
    () => rx.spans().some((s) => s.trace_id === jobTrace && s.parent_id === 'undefined'),
    EXPORT_TIMEOUT_MS
  ).catch(() => null)
  const jobSpans = rx.spans().filter((s) => s.trace_id === jobTrace)
  const root = jobSpans.find((s) => s.parent_id === 'undefined')
  check(
    `${fxOn.slug}: the distill job root is an agent span with the seed's root id and session = case`,
    root?.meta?.kind === 'agent' &&
      root.span_id === rootIdFor(jobSeed) &&
      root.session_id === fxOn.slug &&
      root.meta.metadata?.['argus.state'] === 'done',
    root
  )
  const stages = jobSpans.filter((s) => s.meta?.kind === 'llm')
  check(
    `${fxOn.slug}: ≥4 llm stage spans under the root, each with model and input_tokens`,
    Boolean(root) &&
      stages.length >= 4 &&
      stages.every(
        (s) =>
          s.parent_id === root.span_id &&
          DEC.test(s.span_id) &&
          typeof s.meta.model_name === 'string' &&
          typeof s.metrics?.input_tokens === 'number'
      ),
    stages.map((s) => [s.name, s.parent_id, s.meta?.model_name, s.metrics])
  )
  const bodies = rx.spanBodies()
  check(
    'every span payload is type span with ml_app and the shared tags',
    bodies.length > 0 &&
      bodies.every(
        (b) =>
          b.data?.type === 'span' &&
          b.data.attributes.ml_app === ML_APP &&
          tagOf(b.data.attributes.tags, 'service') === 'argus' &&
          tagOf(b.data.attributes.tags, 'env') === 'gate'
      ),
    bodies.map((b) => b.data?.attributes?.tags)
  )
  const stageTexts = Object.values(fxOn.stages)
    .map((st) => st?.text)
    .filter((t) => typeof t === 'string' && t.length >= 40)
    .map((t) => t.slice(0, 40))
  const wire = JSON.stringify([rx.spanBodies(), rx.evalBodies()])
  const leaked = stageTexts.filter(
    (m) => wire.includes(m) || wire.includes(JSON.stringify(m).slice(1, -1))
  )
  check(
    'captureContent off: no stage raw text anywhere on the wire, and no input/output on any span',
    stageTexts.length >= 4 &&
      leaked.length === 0 &&
      rx.spans().every((s) => s.meta?.input === undefined && s.meta?.output === undefined),
    { markers: stageTexts.length, leaked }
  )
  check(
    'no request hit a wrong path, every body decoded, none forbidden, no duplicate evaluations',
    rx.wrongPath() === 0 &&
      rx.undecoded() === 0 &&
      rx.forbidden() === 0 &&
      rx.duplicates() === 0 &&
      rx.zeroDuration() === 0,
    {
      wrong: rx.lastWrongPath(),
      undecoded: rx.undecoded(),
      forbidden: rx.forbidden(),
      duplicates: rx.duplicates(),
      zeroDuration: rx.zeroDuration()
    }
  )

  // ---- rotation: IT swaps the key; no restart ----
  console.error('\n--- key rotation ---')
  rx.allowKey(KEY2)
  rx.revokeKey(KEY1)
  writePolicy({ ...block1, apiKey: KEY2 })
  const rotated = await waitFor(
    'health ok with the rotated key',
    async () => {
      const r = await runHealth(conn, HEALTH_ROW)
      return r?.ok === true && rx.keysSeen().at(-1) === KEY2 ? r : null
    },
    POLICY_RELOAD_MS
  ).catch(() => null)
  check('rotation: the rewritten key is picked up without a restart', Boolean(rotated), {
    lastKey: rx.keysSeen().at(-1) === KEY2 ? 'key-2' : 'not key-2'
  })

  // ---- removal: delete the file → back to off ----
  console.error('\n--- policy removed ---')
  fs.rmSync(POLICY)
  const gone = await waitFor(
    'app reports no policy',
    async () => ((await conn.evalJs(`window.argus.policy.get()`))?.present === false ? true : null),
    POLICY_RELOAD_MS
  ).catch(() => false)
  check('removal: the app reports no policy', gone)
  const rowsAfter = (await conn.evalJs(`window.argus.health.list()`)) ?? []
  check(
    'removal: the datadog and policy health rows are gone',
    !rowsAfter.some((r) => r.id === HEALTH_ROW || r.id === 'policy'),
    rowsAfter.map((r) => r.id)
  )
  await sleep(QUIET_WINDOW_MS) // the rebuild's shutdown flush lands first
  const before = rx.requests()
  await closeFixture(conn, fxOff)
  const offRows = withDb((db) => readActual(db, fxOff.slug, {}).rows)
  check(
    `removal: ${fxOff.slug} wrote ${judged.length} judged verdicts (scores WOULD be emitted)`,
    offRows.filter((r) => r.verdict !== null).length === judged.length,
    offRows.map((r) => `${r.name}:${r.verdict}`)
  )
  await sleep(QUIET_WINDOW_MS)
  check('removal: no request reached the receiver after the close', rx.requests() === before, {
    before,
    after: rx.requests()
  })

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
