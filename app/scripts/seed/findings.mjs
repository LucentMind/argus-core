import fs from 'node:fs'
import path from 'node:path'

const P = 'hmt/src'

/** One descriptor per visual case the findings pane can render. */
export function buildFlagshipFindings({ freshHead, staleHead }) {
  return [
    {
      summary: 'Legacy admin token compared with a non-constant-time equality check',
      layer: 'security',
      severity: 'critical',
      diffPath: `${P}/auth.js`,
      diffLine: 34,
      headSha: freshHead,
      commentUrl: null,
      pushedSha: null,
      suggestedChange: 'Use timingSafeEqual on hashed values.',
      commentBody: null,
      state: 'pending',
      mode: 'review',
      body: null
    },
    {
      summary: 'Burst allowance applies to every client, not the quiet client the comment promises',
      layer: 'correctness',
      severity: 'major',
      diffPath: `${P}/rateLimiter.js`,
      diffLine: 57,
      headSha: freshHead,
      commentUrl: null,
      pushedSha: null,
      suggestedChange: null,
      commentBody: 'The burst never checks when the limit was hit.',
      state: 'pending',
      mode: 'review',
      body: `The in-diff comment justifies the burst as being for a client that has spent most of its window without exhausting the limit — but the code never checks *when* the limit was hit.

**Failure scenario**: a flood client exhausts \`limit\` (100) in the first second; from the halfway mark it receives 20 further allowed requests. The effective per-window cap for abusive clients is \`limit + burst\` (120), not \`limit\`.

See [hmt/src/rateLimiter.js:57] and [hmt/src/rateLimiter.js:22].`
    },
    {
      summary: 'No test coverage for the burst allowance or the legacy-token fallback',
      layer: 'tests',
      severity: 'major',
      diffPath: `${P}/__tests__/rateLimiter.test.js`,
      diffLine: 12,
      headSha: staleHead,
      commentUrl: null,
      pushedSha: null,
      suggestedChange: 'Add a window-boundary case.',
      commentBody: null,
      state: 'accepted',
      mode: 'review',
      body: null
    },
    {
      // The worst case: longest layer label AND all three status badges on one row.
      summary: 'Unrelated probe file src/notes.js included in the pull request',
      layer: 'design-conformance',
      severity: 'minor',
      diffPath: `${P}/notes.js`,
      diffLine: 1,
      headSha: staleHead,
      commentUrl: 'https://github.com/JiaweiHan88/HiveMindTest/pull/4#discussion_r9',
      pushedSha: 'fedcba9876543210fedcba9876543210fedcba98',
      suggestedChange: 'Drop the file from the branch.',
      commentBody: 'This file is unrelated to the change.',
      state: 'pending',
      mode: 'review',
      body: null
    },
    {
      summary:
        'The rate limiter stores one counter per client id with no eviction, so a service that sees unbounded client identifiers grows its heap without limit until the process is restarted by the supervisor',
      layer: 'correctness',
      severity: 'critical',
      diffPath: `${P}/rateLimiter.js`,
      diffLine: 8,
      headSha: freshHead,
      commentUrl: null,
      pushedSha: null,
      suggestedChange: 'Evict entries older than one window.',
      commentBody: null,
      state: 'rejected',
      mode: 'review',
      body: null
    },
    {
      summary: 'Public endpoint list is matched by prefix, so /public-admin bypasses auth',
      layer: 'security',
      severity: 'critical',
      diffPath: `${P}/auth.js`,
      diffLine: 12,
      headSha: staleHead,
      commentUrl: 'https://github.com/JiaweiHan88/HiveMindTest/pull/4#discussion_r10',
      pushedSha: null,
      suggestedChange: null,
      commentBody: 'Prefix match is too permissive here.',
      state: 'pending',
      mode: 'review',
      body: null
    },
    {
      summary: 'Fix pushed: legacy token now hashed on both sides',
      layer: 'security',
      severity: 'minor',
      diffPath: `${P}/auth.js`,
      diffLine: 41,
      headSha: freshHead,
      commentUrl: null,
      pushedSha: '6e8146a0000000000000000000000000000000aa',
      suggestedChange: 'Hash both sides before comparing.',
      commentBody: null,
      state: 'accepted',
      mode: 'review',
      body: null
    },
    {
      summary: 'Error path returns 200 with an empty body instead of 429',
      layer: 'design-conformance',
      severity: 'minor',
      diffPath: `${P}/rateLimiter.js`,
      diffLine: 72,
      headSha: freshHead,
      commentUrl: null,
      pushedSha: null,
      suggestedChange: null,
      commentBody: null,
      state: 'rejected',
      mode: 'review',
      body: null
    },
    {
      // Unflavored: renders no rail, no anchor, no badges.
      summary: 'Plain finding with no severity or layer',
      layer: null,
      severity: null,
      diffPath: null,
      diffLine: null,
      headSha: null,
      commentUrl: null,
      pushedSha: null,
      suggestedChange: null,
      commentBody: null,
      state: 'pending',
      mode: 'review',
      body: null
    },
    {
      summary: 'Cold-boot timeout reproduces only when the tile cache is empty',
      layer: null,
      severity: null,
      diffPath: null,
      diffLine: null,
      headSha: null,
      commentUrl: null,
      pushedSha: null,
      suggestedChange: null,
      commentBody: null,
      state: 'accepted',
      mode: 'investigation',
      body: null
    },
    {
      summary: 'Log timestamps are local time, not UTC — the 2h gap is a timezone artifact',
      layer: null,
      severity: null,
      diffPath: null,
      diffLine: null,
      headSha: null,
      commentUrl: null,
      pushedSha: null,
      suggestedChange: null,
      commentBody: null,
      state: 'rejected',
      mode: 'investigation',
      body: null
    }
  ]
}

export function buildThinFindings(slug) {
  return [
    {
      summary: `Duplicated retry constant in the ${slug} diff`,
      layer: 'correctness',
      severity: 'minor',
      diffPath: `${P}/rateLimiter.js`,
      diffLine: 19,
      headSha: null,
      commentUrl: null,
      pushedSha: null,
      suggestedChange: 'Extract the constant.',
      commentBody: null,
      state: 'pending',
      mode: 'review',
      body: null
    },
    {
      summary: `Missing negative test for the ${slug} branch`,
      layer: 'tests',
      severity: 'major',
      diffPath: `${P}/__tests__/rateLimiter.test.js`,
      diffLine: 4,
      headSha: null,
      commentUrl: null,
      pushedSha: null,
      suggestedChange: null,
      commentBody: 'Please add the failing case.',
      state: 'accepted',
      mode: 'review',
      body: null
    }
  ]
}

/**
 * Insert the descriptors and rewrite findings.md. Bodies are joined back to rows
 * by the `<!-- finding:{id} -->` marker, so the file must be written AFTER the
 * inserts return their ids.
 */
export function seedFindings(ctx, { caseId, sessionIds, descriptors, slug }) {
  const now = ctx.nowIso()
  ctx.db.prepare('DELETE FROM findings WHERE case_id = ?').run(caseId)
  const ins = ctx.db.prepare(
    `INSERT INTO findings
       (case_id, session_id, turn_id, summary, review_state, reviewed_at, created_at,
        layer, severity, diff_path, diff_line, suggested_change, comment_url, pushed_sha,
        comment_body, head_sha)
     VALUES (?, ?, NULL, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
  )
  const seeded = descriptors.map((f) => {
    const r = ins.run(
      caseId,
      sessionIds[f.mode],
      f.summary,
      f.state,
      f.state === 'pending' ? null : now,
      now,
      f.layer,
      f.severity,
      f.diffPath,
      f.diffLine,
      f.suggestedChange,
      f.commentUrl,
      f.pushedSha,
      f.commentBody,
      f.headSha
    )
    return { id: Number(r.lastInsertRowid), summary: f.summary, body: f.body }
  })

  const dir = ctx.caseDir(slug)
  fs.mkdirSync(dir, { recursive: true })
  let md = `# Findings — ${slug}\n\n`
  for (const f of seeded) {
    if (!f.body) continue
    md += `<!-- finding:${f.id} -->\n## ${f.summary}\n_${now}_\n\n${f.body}\n\n`
  }
  fs.writeFileSync(path.join(dir, 'findings.md'), md, 'utf8')
  return seeded.map((f) => f.id)
}
