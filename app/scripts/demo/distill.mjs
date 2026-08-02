/**
 * Distill jobs and accepted case summaries.
 *
 * Three constraints carried over from the test fixture, each learned the hard way:
 *
 *  1. `id` is INTEGER PRIMARY KEY AUTOINCREMENT — string ids cannot be stored at all.
 *  2. Every job needs a DISTINCT case_slug: buildEvalBundle selects
 *     `WHERE id IN (SELECT MAX(id) FROM distill_jobs GROUP BY case_slug)`, so two jobs sharing a
 *     slug silently drops the older one from the export along with every proposal stamped to it.
 *  3. A `failed` job MUST carry a non-null raw_output — evalExport treats a failed job with no
 *     output as a corpus defect, so seeding one without it makes the export report a problem the
 *     fixture itself created.
 *
 * The `job:` stamps in knowledge.mjs are the STRING form of these integer ids, because
 * evalExport compares against `String(r.id)`. Job 1 is the prior case (7 archived proposals
 * stamped to it); job 2 is the flagship (1 pending proposal, so the export skips it with
 * 'items pending review' — the skip-reason demonstrator).
 */
export function seedDistill(ctx) {
  const slugPlaceholders = ctx.SLUGS.map(() => '?').join(',')
  // Scoped to this roster, never a blanket wipe: distill_jobs and case_summaries have no
  // directory the seed-time guard can inspect, so an unscoped delete would silently destroy a
  // real home's history with no --force prompt to catch it.
  ctx.db
    .prepare(`DELETE FROM distill_jobs WHERE case_slug IN (${slugPlaceholders})`)
    .run(...ctx.SLUGS)

  const ins = ctx.db.prepare(
    `INSERT INTO distill_jobs (id, case_slug, state, input_snapshot, prompt_hash, raw_output, error, item_count, created_at, finished_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
  )
  const snapshot = (f, e, s) => JSON.stringify({ findings: f, evidence: e, sessions: s })

  const jobs = [
    // item_count is the number of proposals actually staged by that run, and must match the
    // corpus in knowledge.mjs exactly — a fixture whose whole point is trustworthy data must
    // not lie about its own counts. Job 1 carries 7 stamped proposals, job 2 carries 1.
    [
      1,
      'HMT-9-quota-drift',
      'done',
      snapshot(2, 2, 1),
      'sha256:9f2c1a',
      '{"items":[{"type":"memory-append"},{"type":"reference-edit"}]}',
      null,
      7,
      ctx.at(ctx.T.PRIOR_CLOSED + 1),
      ctx.at(ctx.T.PRIOR_CLOSED)
    ],
    [
      2,
      'HMT-1-burst-token',
      'done',
      snapshot(7, 5, 2),
      'sha256:9f2c1a',
      '{"items":[{"type":"skill-new"},{"type":"reference-edit"},{"type":"memory-append"},{"type":"case-summary"}]}',
      null,
      4,
      ctx.at(ctx.T.DISTILL),
      ctx.at(ctx.T.PROPOSALS)
    ],
    [
      3,
      'HMT-3-cancelled',
      'failed',
      snapshot(2, 1, 1),
      'sha256:41b70e',
      '{"items":[',
      'unterminated JSON from the model',
      null,
      ctx.at(ctx.T.DISTILL - 2),
      ctx.at(ctx.T.DISTILL - 2)
    ],
    [
      4,
      'NAV-212-route-flicker',
      'queued',
      snapshot(2, 0, 1),
      null,
      null,
      null,
      null,
      ctx.at(2),
      null
    ]
  ]
  for (const j of jobs) ins.run(...j)

  // ── Case summaries: what prior-case retrieval actually returns. ──
  ctx.db
    .prepare(`DELETE FROM case_summaries WHERE case_slug IN (${slugPlaceholders})`)
    .run(...ctx.SLUGS)
  ctx.db
    .prepare(`DELETE FROM case_summaries_fts WHERE case_slug IN (${slugPlaceholders})`)
    .run(...ctx.SLUGS)
  const insSum = ctx.db.prepare(
    `INSERT INTO case_summaries (case_slug, signature, symptoms, root_cause, fix, keywords, resolution, accepted_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
  )
  const insFts = ctx.db.prepare(
    `INSERT INTO case_summaries_fts (signature, symptoms, root_cause, fix, keywords, case_slug)
     VALUES (?, ?, ?, ?, ?, ?)`
  )
  const summaries = [
    [
      'HMT-9-quota-drift',
      'fixed-window counter resets mid-flight, giving a client part of two windows',
      'Quota accounting reported 114/100 for a single window; clients straddling the boundary were over-served.',
      'The window counter resets on a wall-clock boundary while requests are still in flight, so a request counted in the old window is served against the new one.',
      'Close the window against in-flight requests before resetting, and assert the effective quota across a boundary in tests.',
      ['quota', 'window', 'boundary', 'drift', 'in-flight', 'reset'],
      'solved',
      ctx.at(ctx.T.PRIOR_CLOSED)
    ],
    [
      'NAV-305-tile-cache',
      'route calculation timeout on cold boot only, with an empty tile cache',
      'First route request after a cold boot timed out after 30s; never reproduced on a warm cache.',
      'Tile cache warm-up races the first route request; the route path waits on a cache that is still populating.',
      'Gate the first route request on cache-ready, and compare first-request against cache-ready timestamps when triaging.',
      ['tile', 'cache', 'cold-boot', 'timeout', 'route', 'warm-up'],
      'solved',
      ctx.at(ctx.T.PRIOR_CLOSED - 20)
    ]
  ]
  for (const s of summaries) {
    const keywords = s[5]
    // Mirrors upsertCaseSummary(): the TABLE column stores JSON (getCaseSummary does
    // JSON.parse), while the FTS index gets the space-joined form so MATCH can tokenize it.
    insSum.run(s[0], s[1], s[2], s[3], s[4], JSON.stringify(keywords), s[6], s[7])
    insFts.run(s[1], s[2], s[3], s[4], keywords.join(' '), s[0])
  }
  return { jobs: jobs.length, summaries: summaries.length }
}
