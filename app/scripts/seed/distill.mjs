/**
 * Distill rows. States are queued | running | done | failed (queue.ts).
 *
 * Three constraints, each learned the hard way:
 *
 * 1. `id` is INTEGER PRIMARY KEY AUTOINCREMENT (db.ts). String ids like 'job-1'
 *    do not merely read oddly — they cannot be stored. Verified against a real
 *    database: ids are integers.
 * 2. Every job needs a DISTINCT case_slug. buildEvalBundle selects
 *    `WHERE id IN (SELECT MAX(id) FROM distill_jobs GROUP BY case_slug)`
 *    (evalExport.ts:50), so two jobs sharing a slug means the older one is
 *    silently dropped from the export — along with every archived proposal
 *    stamped to it.
 * 3. A failed job MUST carry a non-null raw_output: evalExport.ts treats a failed
 *    job with no output as a corpus defect, so seeding one without it would make
 *    the export report a problem the seed itself created.
 *
 * The `job:` stamps written by knowledge.mjs are the STRING FORM of these integer
 * ids ('1', '2'), because evalExport.ts compares against `String(r.id)`. Changing
 * an id here without changing those stamps orphans the archived corpus.
 */
export function seedDistill(ctx) {
  const now = ctx.nowIso()
  // Scoped to the five roster slugs, NOT a blanket DELETE: distill_jobs, case_summaries
  // and case_summaries_fts have no directory the seed-time guard can check (unlike
  // references/memory/proposals), so an unscoped delete here would silently wipe a real
  // home's distill history and accepted case summaries for cases this seed never touches,
  // with no --force prompt to catch it. seedCases (cases.mjs) already deletes each
  // roster slug's own rows up front; these deletes are scoped the same way so this
  // function is safe to reason about on its own.
  const slugPlaceholders = ctx.SLUGS.map(() => '?').join(',')
  ctx.db
    .prepare(`DELETE FROM distill_jobs WHERE case_slug IN (${slugPlaceholders})`)
    .run(...ctx.SLUGS)
  const ins = ctx.db.prepare(
    `INSERT INTO distill_jobs (id, case_slug, state, input_snapshot, prompt_hash, raw_output, error, item_count, created_at, finished_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
  )
  const snapshot = JSON.stringify({ findings: 3, evidence: 5, sessions: 2 })
  // Integer ids, and one distinct case_slug each — see the constraints above.
  //
  // item_count is the number of proposals actually staged by that run (queue.ts's
  // runJob: `item_count=?` is `res.staged` from stageDistillOutput). Job 1 has 7
  // proposals stamped `job: 1` in knowledge.mjs (timezone-note, req-1042-note,
  // write-good-code, token-compare-note, burst-window-math-2, ci-note, glossary — the
  // last moved here from job 2 to agree with job 1's own case_slug); job 2 has exactly
  // 1 (the pending case-summary proposal, case HMT-4-nochecks, matching this row).
  // Both counts must match the corpus in knowledge.mjs's buildProposals() exactly —
  // a fixture whose whole point is trustworthy data must not lie about its own counts.
  const jobs = [
    [
      1,
      'HMT-1-burst-token',
      'done',
      snapshot,
      'sha256:9f2c1a',
      '{"items":[{"type":"memory-append"}]}',
      null,
      7,
      now,
      now
    ],
    [
      2,
      'HMT-4-nochecks',
      'done',
      snapshot,
      'sha256:9f2c1a',
      '{"items":[{"type":"skill-edit"}]}',
      null,
      1,
      now,
      now
    ],
    [
      3,
      'HMT-3-cancelled',
      'failed',
      snapshot,
      'sha256:41b70e',
      '{"items":[',
      'unterminated JSON from the model',
      null,
      now,
      now
    ],
    [4, 'HMT-2-green', 'queued', snapshot, null, null, null, null, now, null]
  ]
  for (const j of jobs) ins.run(...j)

  // Case summaries + their FTS rows, so prior-case retrieval returns hits. Scoped to the
  // roster slugs for the same reason as distill_jobs above.
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
      'HMT-4-nochecks',
      'auth bypass via prefix match on public endpoint list',
      'Requests to /public-admin reached admin handlers without a token.',
      'The public-endpoint allowlist was matched by prefix rather than exact path.',
      'Match the path exactly, and add a negative test for /public-admin.',
      ['auth', 'bypass', 'prefix', 'match', 'public', 'endpoint'],
      'solved'
    ],
    [
      'HMT-3-cancelled',
      'verify job cancelled by a concurrency group, read as a failure',
      'A red pull request whose verify job was never actually run.',
      'The workflow concurrency group cancelled the in-flight run on every push.',
      'Widen the concurrency key, and re-run before reading the log.',
      ['cancelled', 'concurrency', 'group', 'verify', 'workflow'],
      'solved'
    ]
  ]
  for (const s of summaries) {
    const keywords = s[5]
    // Matches upsertCaseSummary() (distill/summaries.ts) exactly: the TABLE column
    // stores JSON (getCaseSummary() does `JSON.parse(r.keywords)`, so a bare
    // space-joined string there throws for every caller), while the FTS index gets
    // the space-joined form so MATCH queries can tokenize it.
    insSum.run(s[0], s[1], s[2], s[3], s[4], JSON.stringify(keywords), s[6], now)
    insFts.run(s[1], s[2], s[3], s[4], keywords.join(' '), s[0])
  }
  return { jobs: jobs.length, summaries: summaries.length }
}
