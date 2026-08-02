import fs from 'node:fs'
import path from 'node:path'
import { CODE } from './transcript.mjs'

const P = 'hmt/src'

/**
 * The flagship's findings.
 *
 * Every one of these is TRUE of the real HiveMindTest PR-4 checkout. That is not fastidiousness
 * for its own sake: the demo's whole claim is that a citation lands on the line that says what
 * the finding says it says, and a viewer who clicks one that doesn't has been shown the product
 * lying. The earlier test fixture asserted a non-constant-time token comparison in auth.js —
 * which is false, `safeEqual` uses `crypto.timingSafeEqual` with a length pre-check
 * (auth.js:38). The real security defect is one line into the failure path, and it is worse.
 *
 * `body` is the only long-form field the pane will render (behind the chevron, and only when
 * non-null — FindingCard.tsx), and `suggested_change` is never displayed at all. So everything
 * worth reading goes in `body`, and `suggestedChange` is set only where the Apply button should
 * light up.
 */
export function buildFlagshipFindings({ freshHead, staleHead, anchors }) {
  const L = anchors
  return [
    // ── Investigation ──
    {
      summary:
        'Burst allowance is gated on window position, not on whether the client paced its window',
      layer: 'correctness',
      severity: 'major',
      diffPath: `${P}/rateLimiter.js`,
      diffLine: CODE.rlPositionGate,
      headSha: freshHead,
      commentUrl: null,
      pushedSha: null,
      suggestedChange: null,
      commentBody: null,
      state: 'accepted',
      mode: 'investigation',
      body: `The burst allowance is documented twice — in the deployed config (\`"intent": "reward clients that have spent most of the window without exhausting the limit"\`) and as a comment directly above the gate [${P}/rateLimiter.js:${CODE.rlIntentComment}]. Both describe **pacing**: did this client spread its requests across the window.

The implementation evaluates **position**: \`resetsIn(clientId) >= this.windowMs / 2\` [${P}/rateLimiter.js:${CODE.rlPositionGate}], which asks only how much of the window remains. Nothing in the module records when \`count\` reached \`limit\` — \`resetsIn\` is derived purely from \`openedAt\` [${P}/rateLimiter.js:${CODE.rlResetsIn}] — so the documented condition cannot be evaluated as written.

**Failure scenario.** A client exhausts all 100 requests in the first four seconds of its window: \`count=100/100 elapsed_ms=4021 remaining_ms=55979\` [evidence/app.log:${L.limitReached}]. It is correctly refused while more than half the window remains [evidence/app.log:${L.first429}]. At 30014ms elapsed, \`resetsIn\` returns 29986 — just under \`windowMs / 2\` — so the guard falls through and the burst is granted: \`reason=past-window-midpoint\` [evidence/app.log:${L.firstBurstGrant}]. It is then served up to \`limit + burst\` [${P}/rateLimiter.js:${CODE.rlBurstCap}], finishing the window at \`served=120/100 effective_cap=120\` [evidence/app.log:${L.burstExhausted}].

For a client that actually paced itself, position and pacing agree — which is why this survived review. For a flood client they are opposites: it is maximally past the midpoint precisely because it was maximally abusive. The effective per-window cap for the worst clients is \`limit + burst\`, not \`limit\`.`
    },
    {
      summary: 'Burst grants to flood clients saturate the upstream pool and starve paced clients',
      layer: 'correctness',
      severity: 'minor',
      diffPath: null,
      diffLine: null,
      headSha: null,
      commentUrl: null,
      pushedSha: null,
      suggestedChange: null,
      commentBody: null,
      state: 'accepted',
      mode: 'investigation',
      body: `Same root cause as the window-position finding, kept separate because this is the half the ticket will actually be judged on.

While \`flood-7\` is spending its burst, the upstream pool reaches \`in_flight=64/64 queued=118 top_client=flood-7\`, and \`quiet-9\` — three requests into its own window, nowhere near its limit — is refused with \`reason=upstream-saturated\` [evidence/app.log:${L.starvedClient}].

The burst exists to protect exactly that client. As implemented it is funding the client that starves it.`
    },
    // ── Review ──
    {
      summary: 'Rejected admin token is written to the log in plaintext',
      layer: 'security',
      severity: 'critical',
      diffPath: `${P}/auth.js`,
      diffLine: CODE.authLeak,
      headSha: freshHead,
      commentUrl: 'https://github.com/JiaweiHan88/HiveMindTest/pull/4#discussion_r2214870031',
      pushedSha: null,
      suggestedChange: 'Log the outcome, not the credential.',
      commentBody: 'This writes a live credential to the log on every failed admin auth.',
      state: 'pending',
      mode: 'review',
      body: `\`verifyLegacy\` interpolates the submitted token into its rejection warning: \`logger.warn(\\\`admin request with an invalid legacy token: \\\${token}\\\`)\` [${P}/auth.js:${CODE.authLeak}].

The comparison above it is sound — \`safeEqual\` hashes both sides and uses \`crypto.timingSafeEqual\` behind a length pre-check [${P}/auth.js:${CODE.authSafeEqual}] — so this is not a timing issue. It is a disclosure one.

**Failure scenario.** A deploy script is misconfigured with a token belonging to a different environment. Every retry writes that still-valid credential, in plaintext, into a log that is shipped to the central aggregator and readable by anyone with log access. The near-misses are the ones worth stealing: a typo'd deploy token is still a valid deploy token somewhere else.

Log the outcome, never the credential — a hash prefix is enough to correlate retries without disclosing anything.`
    },
    {
      summary: 'Burst gate reads window position where the documented intent is client pacing',
      layer: 'correctness',
      severity: 'major',
      diffPath: `${P}/rateLimiter.js`,
      diffLine: CODE.rlPositionGate,
      headSha: freshHead,
      commentUrl: 'https://github.com/JiaweiHan88/HiveMindTest/pull/4#discussion_r2214870194',
      pushedSha: null,
      suggestedChange: 'Record when the limit was reached and gate the burst on that.',
      commentBody:
        'The gate asks how much window is left, not whether the client paced itself — opposite answers for a flood client.',
      state: 'pending',
      mode: 'review',
      body: `The diff-side view of the same defect the investigation found in production.

\`allow\` refuses an over-limit client only while more than half the window remains [${P}/rateLimiter.js:${CODE.rlPositionGate}], then serves it up to \`limit + burst\` [${P}/rateLimiter.js:${CODE.rlBurstCap}]. The comment immediately above claims the allowance is for "a client that has spent most of its window without exhausting the limit" [${P}/rateLimiter.js:${CODE.rlIntentComment}] — a condition the module has no state to evaluate.

**Fix shape.** Record \`limitReachedAt\` on the bucket when \`count\` first hits \`limit\`, and gate the burst on that being late in the window rather than on \`resetsIn\` alone. The attached \`artifacts/diff.patch\` sketches it.`
    },
    {
      summary:
        'No test exercises the burst path; the limit test passes only because its clock never advances',
      layer: 'tests',
      severity: 'major',
      diffPath: `${P}/__tests__/rateLimiter.test.js`,
      diffLine: CODE.testLimit,
      headSha: freshHead,
      commentUrl: null,
      pushedSha: null,
      suggestedChange: 'Add a window-boundary case that advances past the midpoint.',
      commentBody: null,
      state: 'accepted',
      mode: 'review',
      body: `This is why the defect shipped.

\`allows requests up to the limit\` builds a limiter with \`limit: 3\` and asserts the fourth request is refused [${P}/__tests__/rateLimiter.test.js:${CODE.testLimit}]. That assertion holds only because the injected clock is never advanced: at \`t = 0\`, \`resetsIn\` returns the full \`windowMs\`, so the position gate refuses and the burst branch is never entered.

Advance the clock past the midpoint before the fourth call and the request is **granted** — which is the production behaviour, and the opposite of what the test's name implies it is protecting.

All five tests in the file share this property: none of them enters the burst branch at all, so \`allow\`'s defect is invisible to CI. The failing job in the artifacts is the first thing that actually exercised it: \`expected 100 served, got 120\` [artifacts/ci/verify-b.log:6].`
    },
    {
      summary: 'Unrelated probe file src/notes.js shipped in the pull request',
      layer: 'design-conformance',
      severity: 'minor',
      diffPath: `${P}/notes.js`,
      diffLine: CODE.notes,
      headSha: staleHead,
      commentUrl: null,
      pushedSha: null,
      suggestedChange: 'Drop the file from the branch.',
      commentBody: null,
      state: 'pending',
      mode: 'review',
      body: null
    },
    {
      // The plausible-but-wrong one. Its rejection is the human-in-the-loop half of the story:
      // sweep() genuinely does evict, so this finding is real-sounding and false.
      summary: 'Bucket map grows without bound because expired windows are never evicted',
      layer: 'correctness',
      severity: 'critical',
      diffPath: `${P}/rateLimiter.js`,
      diffLine: 30,
      headSha: staleHead,
      commentUrl: null,
      pushedSha: null,
      suggestedChange: null,
      commentBody: null,
      state: 'rejected',
      mode: 'review',
      body: `Rejected on review: this is wrong.

\`sweep()\` [${P}/rateLimiter.js:109] drops every bucket whose window has expired, and its own test asserts the behaviour [${P}/__tests__/rateLimiter.test.js:52]. The eviction is deliberately off the request path — sweeping the whole map per request would make the limiter the bottleneck it exists to prevent — which is what made it look absent from \`allow\`.`
    }
  ]
}

/** The prior case: solved, and the origin of the knowledge the flagship reuses. */
export function buildPriorFindings() {
  return [
    {
      summary:
        'Fixed-window counter resets mid-flight, so a client straddling the boundary gets two windows',
      layer: 'correctness',
      severity: 'major',
      diffPath: null,
      diffLine: null,
      headSha: null,
      commentUrl: null,
      pushedSha: null,
      suggestedChange: null,
      commentBody: null,
      state: 'accepted',
      mode: 'investigation',
      body: `The window counter resets on a wall-clock boundary while requests are still in flight, so a client whose burst straddles the boundary is counted partly against each window and receives \`limit + inflight\` across the pair [evidence/quota-drift.log:2].

**This is the case that produced the \`burst-window-math\` memory** — the generalisation being that any limiter gate expressed in terms of *where we are in the window* rather than *what this client has actually done* inverts under load.`
    },
    {
      summary: 'Quota accounting reports 114/100 for a single window',
      layer: 'correctness',
      severity: 'minor',
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
    }
  ]
}

export function buildThinFindings(slug) {
  return [
    {
      summary: `Retry constant duplicated across the ${slug} change`,
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
 * Insert the descriptors and rewrite findings.md. Bodies are joined back to rows by the
 * `<!-- finding:{id} -->` marker, so the file must be written AFTER the inserts return ids.
 */
export function seedFindings(ctx, { caseId, sessionIds, descriptors, slug, at, hours }) {
  // Per-case, because a finding's timestamp competes in derivePhase like every other signal.
  // The defaults put review findings newest, which is what makes the flagship read 'reviewing';
  // HMT-4-nochecks overrides them to sit BEFORE its pull-request binding, which is the only way
  // that case can read 'pr-created'. A single global constant here silently cost that badge.
  const investigationAt = at(hours?.investigation ?? ctx.T.INVESTIGATION_FINDINGS)
  const reviewAt = at(hours?.review ?? ctx.T.REVIEW_FINDINGS)
  ctx.db.prepare('DELETE FROM findings WHERE case_id = ?').run(caseId)
  const ins = ctx.db.prepare(
    `INSERT INTO findings
       (case_id, session_id, turn_id, summary, review_state, reviewed_at, created_at,
        layer, severity, diff_path, diff_line, suggested_change, comment_url, pushed_sha,
        comment_body, head_sha)
     VALUES (?, ?, NULL, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
  )
  const seeded = descriptors.map((f) => {
    const created = f.mode === 'investigation' ? investigationAt : reviewAt
    const r = ins.run(
      caseId,
      sessionIds[f.mode],
      f.summary,
      f.state,
      f.state === 'pending' ? null : created,
      created,
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
    return { id: Number(r.lastInsertRowid), summary: f.summary, body: f.body, created }
  })

  const dir = ctx.caseDir(slug)
  fs.mkdirSync(dir, { recursive: true })
  let md = `# Findings — ${slug}\n\n`
  for (const f of seeded) {
    if (!f.body) continue
    md += `<!-- finding:${f.id} -->\n## ${f.summary}\n_${f.created}_\n\n${f.body}\n\n`
  }
  fs.writeFileSync(path.join(dir, 'findings.md'), md, 'utf8')
  return seeded.map((f) => f.id)
}
