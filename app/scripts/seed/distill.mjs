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
  ctx.db.exec('DELETE FROM distill_jobs')
  const ins = ctx.db.prepare(
    `INSERT INTO distill_jobs (id, case_slug, state, input_snapshot, prompt_hash, raw_output, error, item_count, created_at, finished_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
  )
  const snapshot = JSON.stringify({ findings: 3, evidence: 5, sessions: 2 })
  // Integer ids, and one distinct case_slug each — see the constraints above.
  const jobs = [
    [
      1,
      'HMT-1-burst-token',
      'done',
      snapshot,
      'sha256:9f2c1a',
      '{"items":[{"type":"memory-append"}]}',
      null,
      1,
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

  // Case summaries + their FTS rows, so prior-case retrieval returns hits.
  ctx.db.exec('DELETE FROM case_summaries')
  ctx.db.exec('DELETE FROM case_summaries_fts')
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
      'auth bypass prefix match public endpoint',
      'solved'
    ],
    [
      'HMT-3-cancelled',
      'verify job cancelled by a concurrency group, read as a failure',
      'A red pull request whose verify job was never actually run.',
      'The workflow concurrency group cancelled the in-flight run on every push.',
      'Widen the concurrency key, and re-run before reading the log.',
      'cancelled concurrency group verify workflow',
      'solved'
    ]
  ]
  for (const s of summaries) {
    insSum.run(...s, now)
    insFts.run(s[1], s[2], s[3], s[4], s[5], s[0])
  }
  return { jobs: jobs.length, summaries: summaries.length }
}
