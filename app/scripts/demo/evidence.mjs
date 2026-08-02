import fs from 'node:fs'
import path from 'node:path'

/**
 * The demo's evidence trees.
 *
 * The app.log below is generated, and every line number the transcript or a finding body
 * cites is returned from here as an ANCHOR rather than typed by hand anywhere else. That is
 * the whole point of the fixture: the demo's central claim is that a cited `[path:line]`
 * lands on the line that says what the agent said it says. A hand-typed line number is that
 * claim quietly becoming false the first time this generator changes — and it would change
 * silently, because nothing else checks it. seed-demo-home.mjs's verify() re-reads the
 * written file and re-checks every anchor against it.
 */

const CLIENTS = ['tiles-eu-1', 'tiles-eu-2', 'tiles-us-1', 'nav-batch-3', 'quiet-9']

function ts(sec, ms = 0) {
  const base = Date.UTC(2026, 6, 28, 10, 0, 0)
  return new Date(base + sec * 1000 + ms).toISOString()
}

/**
 * A rate-limiter log that actually tells the story the case is about: a flood client
 * exhausts its window limit in the first seconds, starts receiving 429s, and is then handed
 * the burst allowance anyway — because the burst check never asks WHEN the limit was hit.
 */
export function buildAppLog() {
  const lines = []
  const anchors = {}
  /** Record the 1-indexed line number that the NEXT pushed line will occupy. */
  const mark = (name) => {
    anchors[name] = lines.length + 1
  }
  const push = (s) => lines.push(s)

  let req = 1000
  const nextReq = () => ++req

  push(`${ts(0)} INFO  tile-service starting pid=48211 node=v22.20.0`)
  push(`${ts(0, 40)} INFO  tile-service loading config from /etc/tile-service/limits.json`)
  mark('configEcho')
  push(
    `${ts(0, 90)} INFO  tile-service rate-limit config limit=100 burst=20 windowMs=60000 strategy=fixed-window`
  )
  push(`${ts(0, 120)} INFO  tile-service tile cache warm entries=18432`)
  push(`${ts(1)} INFO  tile-service listening on 0.0.0.0:8080`)

  // ── Steady traffic: a few hundred ordinary requests across the quiet clients. ──
  for (let i = 0; i < 320; i++) {
    const c = CLIENTS[i % CLIENTS.length]
    const sec = 2 + Math.floor(i / 6)
    const latency = 28 + ((i * 17) % 90)
    push(
      `${ts(sec, (i % 6) * 90)} INFO  tile-service [req=${nextReq()} client=${c}] GET /tile/12/2145/1398 200 latency_ms=${latency}`
    )
  }

  // ── The flood client opens a window and burns the whole limit in four seconds. ──
  const floodWindowStart = 56
  mark('windowOpen')
  push(
    `${ts(floodWindowStart)} INFO  tile-service [client=flood-7] rate-limit window opened windowMs=60000 limit=100 burst=20`
  )
  for (let i = 0; i < 100; i++) {
    const sec = floodWindowStart + Math.floor(i / 25)
    push(
      `${ts(sec, (i % 25) * 40)} INFO  tile-service [req=${nextReq()} client=flood-7] GET /tile/14/8592/5591 200 latency_ms=${31 + (i % 40)} count=${i + 1}/100`
    )
  }

  mark('limitReached')
  push(
    `${ts(floodWindowStart + 4)} WARN  tile-service [client=flood-7] window limit reached count=100/100 elapsed_ms=4021 remaining_ms=55979`
  )
  mark('first429')
  push(
    `${ts(floodWindowStart + 4, 60)} WARN  tile-service [req=${nextReq()} client=flood-7] GET /tile/14/8592/5592 429 reason=window-limit-exceeded`
  )
  for (let i = 0; i < 12; i++) {
    push(
      `${ts(floodWindowStart + 4, 120 + i * 60)} WARN  tile-service [req=${nextReq()} client=flood-7] GET /tile/14/8592/${5593 + i} 429 reason=window-limit-exceeded`
    )
  }

  // ── The defect. The burst is granted on window POSITION alone, with no check of when the
  //    limit was actually hit, so the flood client is topped up mid-window. ──
  mark('firstBurstGrant')
  push(
    `${ts(floodWindowStart + 30)} INFO  tile-service [client=flood-7] burst allowance granted burst=20 window_elapsed_ms=30014 reason=past-window-midpoint`
  )
  for (let i = 0; i < 20; i++) {
    push(
      `${ts(floodWindowStart + 30, 80 + i * 55)} INFO  tile-service [req=${nextReq()} client=flood-7] GET /tile/14/8592/${5610 + i} 200 latency_ms=${33 + (i % 25)} burst=${i + 1}/20`
    )
  }
  mark('burstExhausted')
  push(
    `${ts(floodWindowStart + 32)} WARN  tile-service [client=flood-7] burst exhausted served=120/100 effective_cap=120 window_elapsed_ms=32115`
  )

  // ── The cost: the client the burst was documented to protect is starved by the flood. ──
  mark('starvedClient')
  push(
    `${ts(floodWindowStart + 33)} WARN  tile-service [req=${nextReq()} client=quiet-9] GET /tile/12/2145/1400 429 reason=upstream-saturated count=3/100`
  )
  push(
    `${ts(floodWindowStart + 33, 400)} WARN  tile-service upstream pool saturated in_flight=64/64 queued=118 top_client=flood-7`
  )

  // ── Tail traffic, then the unrelated cold-boot timeout the prior case is about. ──
  for (let i = 0; i < 260; i++) {
    const c = CLIENTS[i % CLIENTS.length]
    const sec = 92 + Math.floor(i / 5)
    push(
      `${ts(sec, (i % 5) * 110)} INFO  tile-service [req=${nextReq()} client=${c}] GET /tile/12/${2100 + (i % 60)}/1402 200 latency_ms=${30 + ((i * 13) % 70)}`
    )
  }
  mark('coldBoot')
  push(
    `${ts(180)} ERROR tile-service cold-boot timeout after 30000ms cache=empty tiles_pending=18432`
  )

  return { text: `${lines.join('\n')}\n`, anchors }
}

/** The flagship's config, cited when the agent reads the limit/burst numbers. */
const CONFIG_JSON = `${JSON.stringify(
  {
    limit: 100,
    burst: 20,
    windowMs: 60000,
    strategy: 'fixed-window',
    burstPolicy: {
      // The comment the review finding contradicts: the policy DOCUMENTS intent that the
      // code does not implement.
      grantAfterWindowFraction: 0.5,
      intent: 'reward clients that have spent most of the window without exhausting the limit'
    }
  },
  null,
  2
)}\n`

const TIMINGS_CSV = [
  'request,client,latency_ms,status,burst_used',
  '1103,flood-7,31,200,0',
  '1120,flood-7,44,429,0',
  '1141,flood-7,38,200,12',
  '1149,quiet-9,512,429,0',
  '1150,quiet-9,498,429,0',
  ''
].join('\n')

/**
 * Evidence is investigation material, artifacts are review material — the directory IS the
 * scope (src/shared/evidenceScope.ts), so the two maps must never share a path.
 */
export function buildTrees(slug, { appLog }) {
  if (slug === 'HMT-1-burst-token') {
    return {
      evidence: {
        'app.log': appLog,
        'config.json': CONFIG_JSON,
        'timings.csv': TIMINGS_CSV,
        'jira/HMT-1.md':
          '# HMT-1 — Burst allowance lets abusive clients exceed the window limit\n\n' +
          '**Reporter:** platform-oncall\n**Priority:** Highest\n\n' +
          'Tile service is returning 429 to well-behaved clients during peak while a single\n' +
          'client (`flood-7`) continues to be served. Grafana shows that client served ~120\n' +
          'requests inside one 60s window against a configured limit of 100.\n\n' +
          'Attached: `app.log` from the affected node, `config.json`, `timings.csv`.\n'
      },
      artifacts: {
        'ci/verify-b.log':
          'verify-b\n> node --test\n\n' +
          'FAIL src/__tests__/rateLimiter.test.js\n' +
          '  ✗ burst allowance applies only to clients that paced their window\n' +
          '    expected 100 served, got 120\n\n' +
          'PASS src/__tests__/auth.test.js\n\nexit status 1\n',
        'ci/unit-tests.log': 'unit-tests\n> node --test\nPASS 14 tests\nexit status 0\n',
        'ci/lint.log': 'lint\n> eslint .\nclean\nexit status 0\n',
        'diff.patch':
          '--- a/src/rateLimiter.js\n+++ b/src/rateLimiter.js\n' +
          '@@ -54,7 +54,10 @@\n' +
          '-  if (elapsed > windowMs / 2) return grantBurst(client)\n' +
          '+  if (elapsed > windowMs / 2 && client.limitReachedAt > windowStart + windowMs / 2) {\n' +
          '+    return grantBurst(client)\n' +
          '+  }\n'
      }
    }
  }
  if (slug === 'HMT-9-quota-drift') {
    return {
      evidence: {
        'quota-drift.log':
          '2026-07-14T08:12:01Z WARN quota-service window boundary crossed mid-request\n' +
          '2026-07-14T08:12:01Z WARN quota-service counter reset while 14 requests in flight\n' +
          '2026-07-14T08:12:02Z INFO quota-service effective quota for window = 114/100\n',
        'notes.md':
          '# HMT-9 — quota drift at window boundaries\n\n' +
          'Root cause: the fixed-window counter resets on a wall-clock boundary while requests\n' +
          'are still in flight, so a client straddling the boundary gets part of two windows.\n\n' +
          'This is the case that produced the `burst-window-math` memory.\n'
      },
      artifacts: {
        'ci/summary.log': 'all checks passed\nexit status 0\n',
        'review-report.md':
          '# Review report — HMT-9\n\nOne finding, accepted and fixed: window-boundary drift.\n'
      }
    }
  }
  // Everything else is dashboard filler and gets NO tree at all — not as an economy, but
  // because an ingested evidence row is stamped at ingestion time, which is newer than every
  // seeded signal. One Rescan on a filler case would outrank its designed timestamps and
  // rewrite its phase badge, collapsing the dashboard's whole phase spread to 'analyzing' /
  // 'reviewing'. Empty trees are what make those badges survive. verify() enforces this.
  return { evidence: {}, artifacts: {} }
}

export function seedFiles(ctx, { appLog }) {
  const counts = {}
  for (const slug of ctx.SLUGS) {
    const trees = buildTrees(slug, { appLog })
    const dir = ctx.caseDir(slug)
    let evidence = 0
    let artifacts = 0
    for (const [rel, content] of Object.entries(trees.evidence)) {
      const dest = path.join(dir, 'evidence', rel)
      fs.mkdirSync(path.dirname(dest), { recursive: true })
      fs.writeFileSync(dest, content)
      evidence++
    }
    for (const [rel, content] of Object.entries(trees.artifacts)) {
      const dest = path.join(dir, 'artifacts', rel)
      fs.mkdirSync(path.dirname(dest), { recursive: true })
      fs.writeFileSync(dest, content)
      artifacts++
    }
    counts[slug] = { evidence, artifacts }
  }
  return counts
}
