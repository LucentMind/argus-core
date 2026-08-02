/**
 * The flagship's two sessions, as AgentEvent streams.
 *
 * These are replayed verbatim: IPC.agentHistory → readSessionEvents (agent/mirror.ts) →
 * agentStore.hydrate() → ChatPane. So the grammar has to be the real one
 * (src/shared/agent-events.ts) and the stream has to look like real output — session.started,
 * content.delta chunks resolving into an assistant.message, interleaved tool call pairs, a
 * turn.completed carrying tokens and cost.
 *
 * Two rendering facts shape everything below (both verified against the renderer):
 *
 *  - A tool card shows ONLY the tool name and `outputPreview` (ToolCallCard.tsx). No args, no
 *    risk chip, no duration. So every tool call's contribution to a screenshot lives entirely
 *    in its outputPreview, which is why they are written out in full here rather than stubbed.
 *  - An approval/permission card cannot be seeded at all: it renders from ephemeral live state
 *    (agentStore.pending) that is cleared on resolution and never replayed from disk. Emitting
 *    request.opened here would produce a card stuck open forever, which is worse than absent.
 *
 * Every `[path:line]` in the prose below is interpolated from a computed anchor or from a line
 * number verified against the real HiveMindTest checkout — never typed from memory. verify()
 * in seed-demo-home.mjs re-reads each cited file and re-checks each line.
 */

/** Line numbers in the PR-4 checkout of HiveMindTest. Verified against the worktree. */
export const CODE = {
  rlAllow: 54,
  rlLimitCheck: 56,
  rlIntentComment: 57,
  rlPositionGate: 60,
  rlBurstCap: 63,
  rlResetsIn: 86,
  authLeak: 70,
  authSafeEqual: 38,
  authVerifyLegacy: 64,
  testLimit: 24,
  notes: 1
}

/** Split text into plausible streaming chunks so the replay is not one atomic blob. */
function chunks(text) {
  const parts = text.split(/(?<=\.)\s+/)
  const out = []
  for (let i = 0; i < parts.length; i += 2) out.push(parts.slice(i, i + 2).join(' '))
  return out.filter(Boolean)
}

function makeStream({ caseId, caseSlug, sessionId }) {
  const events = []
  let n = 0
  let tools = 0
  let turnId = null
  const ev = (type, payload, ts) => {
    events.push({
      eventId: `demo-s${sessionId}-${String(++n).padStart(3, '0')}`,
      caseId,
      caseSlug,
      sessionId,
      turnId,
      ts,
      type,
      payload
    })
  }
  const plus = (ts, sec) => new Date(Date.parse(ts) + sec * 1000).toISOString()
  return {
    events,
    session: (model, ts) => ev('session.started', { model, resumed: false }, ts),
    turn: (id) => {
      turnId = id
    },
    user: (text, ts, composed) =>
      ev('turn.started', composed ? { userText: text, composed: true } : { userText: text }, ts),
    /** Stream the text, then finalize it — the same shape a real driver emits. */
    say: (text, ts) => {
      const cs = chunks(text)
      cs.forEach((c, i) =>
        ev('content.delta', { text: c + (i < cs.length - 1 ? ' ' : '') }, plus(ts, i))
      )
      ev('assistant.message', { text }, plus(ts, cs.length))
    },
    tool: (name, outputPreview, ts, isError = false) => {
      const toolCallId = `tc-${sessionId}-${++tools}`
      ev('tool.call.started', { toolCallId, name }, ts)
      ev('tool.call.completed', { toolCallId, name, outputPreview, isError }, plus(ts, 2))
    },
    done: (ts, inputTokens, outputTokens, costUsd, durationMs) =>
      ev(
        'turn.completed',
        { status: 'success', inputTokens, outputTokens, costUsd, durationMs },
        ts
      )
  }
}

/**
 * Investigation: from "one client is being served past its limit" to the exact line of code
 * that does it, reusing what a previous case already taught us.
 *
 * Turns 2 and 3 are the flywheel's input half — a memory and a HiveMind reference, both
 * produced by HMT-9-quota-drift, are read here and shorten this investigation. They are also
 * what put a non-zero usage count on those Library rows.
 */
export function investigationEvents({ caseId, caseSlug, sessionId, turnIds, model, anchors, at }) {
  const s = makeStream({ caseId, caseSlug, sessionId })
  const L = anchors
  const t = (h) => at(h)

  s.session(model, t(48.2))

  // ── Turn 1: establish the symptom from the evidence, not from the ticket's prose. ──
  s.turn(turnIds[0])
  s.user(
    'HMT-1 is escalating. Platform-oncall says one client is being served well past its ' +
      "limit while well-behaved clients get 429s. The node's app.log, the rate-limit config " +
      'and a timings export are attached. What is actually happening?',
    t(48)
  )
  s.tool(
    'mcp__argus__search_evidence',
    `query: "429 reason=" · 14 hits in evidence/app.log\n\n` +
      `app.log:${L.first429}  WARN [req=1421 client=flood-7] GET /tile/14/8592/5592 429 reason=window-limit-exceeded\n` +
      `app.log:${L.first429 + 1}  WARN [req=1422 client=flood-7] ... 429 reason=window-limit-exceeded\n` +
      `app.log:${L.starvedClient}  WARN [req=1454 client=quiet-9] GET /tile/12/2145/1400 429 reason=upstream-saturated\n` +
      `\n2 distinct reasons: window-limit-exceeded (13), upstream-saturated (1)`,
    t(47.98)
  )
  s.tool(
    'Read',
    `evidence/app.log lines ${L.limitReached}-${L.first429}\n\n` +
      `${L.limitReached}  WARN tile-service [client=flood-7] window limit reached count=100/100 elapsed_ms=4021 remaining_ms=55979\n` +
      `${L.first429}  WARN tile-service [req=1421 client=flood-7] GET /tile/14/8592/5592 429 reason=window-limit-exceeded`,
    t(47.95)
  )
  s.tool(
    'Read',
    `evidence/app.log lines ${L.burstExhausted}-${L.starvedClient}\n\n` +
      `${L.burstExhausted}  WARN tile-service [client=flood-7] burst exhausted served=120/100 effective_cap=120 window_elapsed_ms=32115\n` +
      `${L.starvedClient}  WARN tile-service [req=1454 client=quiet-9] GET /tile/12/2145/1400 429 reason=upstream-saturated count=3/100`,
    t(47.93)
  )
  s.say(
    `The report is accurate, and the log is unusually explicit about it.\n\n` +
      `\`flood-7\` opened a window and spent the entire limit in about four seconds — ` +
      `\`count=100/100 elapsed_ms=4021\` [evidence/app.log:${L.limitReached}] — and was correctly refused ` +
      `from that point [evidence/app.log:${L.first429}].\n\n` +
      `But by the end of the same window it had been served **120** requests against a configured ` +
      `limit of 100: \`burst exhausted served=120/100 effective_cap=120\` ` +
      `[evidence/app.log:${L.burstExhausted}]. The configured limit is 100 with a burst of 20 ` +
      `[evidence/app.log:${L.configEcho}], so the burst allowance was granted to the flood client.\n\n` +
      `The cost is on the next line: \`quiet-9\`, three requests into its own window, is refused ` +
      `with \`upstream-saturated\` [evidence/app.log:${L.starvedClient}] — the client the burst ` +
      `exists to protect is the one being starved by it.`,
    t(47.9)
  )
  s.done(t(47.87), 18420, 640, 0.094, 21400)

  // ── Turn 2: the flywheel's first input — a memory from the prior case. ──
  s.turn(turnIds[1])
  s.user('120 against a limit of 100. Where do the extra 20 come from?', t(47.8))
  s.tool(
    'mcp__argus__read_memory',
    `burst-window-math (3 lines) · last written from HMT-9-quota-drift\n\n` +
      `A burst allowance that is gated on WINDOW POSITION rather than on when the limit was\n` +
      `actually reached raises the effective cap to limit + burst for exactly the clients it\n` +
      `was meant to exclude. Check what the gate reads, not what its comment claims.`,
    t(47.78)
  )
  s.tool(
    'Read',
    `hmt/src/rateLimiter.js lines ${CODE.rlAllow}-${CODE.rlBurstCap}\n\n` +
      `${CODE.rlAllow}  allow(clientId) {\n` +
      `${CODE.rlLimitCheck}    if (bucket.count >= this.limit) {\n` +
      `${CODE.rlIntentComment}      // Burst allowance: a client that has spent most of its window without exhausting the\n` +
      `${CODE.rlPositionGate}      if (this.resetsIn(clientId) >= this.windowMs / 2) {\n` +
      `${CODE.rlPositionGate + 1}        return false\n` +
      `${CODE.rlBurstCap}      if (bucket.count >= this.limit + this.burst) {`,
    t(47.75)
  )
  s.say(
    `From the burst allowance, and the memory from HMT-9 describes this exact shape.\n\n` +
      `The only gate on the burst is \`resetsIn(clientId) >= this.windowMs / 2\` ` +
      `[hmt/src/rateLimiter.js:${CODE.rlPositionGate}] — that asks *how much of the window is left*, ` +
      `nothing more. Once a client is past the halfway point it stops being refused and is served ` +
      `up to \`limit + burst\` [hmt/src/rateLimiter.js:${CODE.rlBurstCap}].\n\n` +
      `The log agrees to the millisecond: the grant is stamped \`window_elapsed_ms=30014 ` +
      `reason=past-window-midpoint\` [evidence/app.log:${L.firstBurstGrant}]. At 30014ms elapsed, ` +
      `\`resetsIn\` returns 29986, which is just under \`windowMs / 2\` = 30000 — so the guard ` +
      `falls through and the burst is granted.`,
    t(47.72)
  )
  s.done(t(47.68), 22140, 810, 0.118, 26800)

  // ── Turn 3: the flywheel's second input — a HiveMind reference — plus the intent contradiction. ──
  s.turn(turnIds[2])
  s.user(
    'Is that the same failure HMT-9 hit? And is the intended behaviour documented anywhere, ' +
      'or am I inferring it?',
    t(47.6)
  )
  s.tool(
    'Read',
    `references/rate-limit-patterns.md · trust tier: team-knowledge\n\n` +
      `## Position is not pacing\n\n` +
      `A window-position check ("are we near the end of the window?") is a proxy for the thing\n` +
      `you actually want ("did this client pace itself?"), and it is a proxy that inverts under\n` +
      `load: the worst client is the one furthest past the midpoint...`,
    t(47.58)
  )
  s.tool(
    'Read',
    `evidence/config.json\n\n` +
      `  "burstPolicy": {\n` +
      `    "grantAfterWindowFraction": 0.5,\n` +
      `    "intent": "reward clients that have spent most of the window without exhausting the limit"\n` +
      `  }`,
    t(47.55)
  )
  s.say(
    `Same failure, and no — you are not inferring the intent, it is written down twice.\n\n` +
      `The deployed config states it: \`"intent": "reward clients that have spent most of the ` +
      `window without exhausting the limit"\`. The code repeats it as a comment directly above the ` +
      `gate [hmt/src/rateLimiter.js:${CODE.rlIntentComment}].\n\n` +
      `Both describe a **pacing** condition — did this client spread its requests across the ` +
      `window. The implementation only ever evaluates a **position** condition — is the window ` +
      `nearly over [hmt/src/rateLimiter.js:${CODE.rlPositionGate}]. For a client that paced itself ` +
      `the two agree, which is why this survived review. For a client that burned its limit in the ` +
      `first four seconds they are opposites: it is maximally past the midpoint precisely because ` +
      `it was maximally abusive.\n\n` +
      `Nothing in the module records *when* \`count\` reached \`limit\` — \`resetsIn\` is derived ` +
      `purely from \`openedAt\` [hmt/src/rateLimiter.js:${CODE.rlResetsIn}] — so the pacing ` +
      `condition cannot be evaluated as written. This is the team note's "position is not ` +
      `pacing" verbatim.`,
    t(47.5)
  )
  s.done(t(47.45), 26900, 1180, 0.171, 34100)

  // ── Turn 4: record it. ──
  s.turn(turnIds[3])
  s.user('Record that as a finding, and note the starved client separately.', t(47.3))
  s.tool(
    'mcp__argus__append_finding',
    `finding #1 recorded · layer: correctness · severity: major\n` +
      `"Burst allowance is gated on window position, not on whether the client paced its window"`,
    t(47.28)
  )
  s.tool(
    'mcp__argus__append_finding',
    `finding #2 recorded · layer: correctness · severity: minor\n` +
      `"Burst grants to flood clients saturate the upstream pool and starve paced clients"`,
    t(47.26)
  )
  s.say(
    `Both recorded.\n\n` +
      `The second is worth keeping separate from the first even though it has the same cause: it ` +
      `is the one that makes this customer-visible. \`quiet-9\` is refused at three requests into ` +
      `its own window [evidence/app.log:${L.starvedClient}] while the pool sits at ` +
      `\`in_flight=64/64 queued=118 top_client=flood-7\`. Fixing the gate fixes both, but the ` +
      `starvation is what the ticket will be judged on.`,
    t(47.22)
  )
  s.done(t(47.18), 29400, 520, 0.083, 14900)

  return s.events
}

/**
 * Review: the same defect seen through the diff, plus what else the pull request carries.
 *
 * The opening turn is `composed: true` — an Argus-composed review-run prompt rather than
 * something typed — so the renderer markdown-renders it, which is what a real review run
 * looks like.
 */
// `anchors` is deliberately not destructured here: the review session cites the diff and the CI
// artifact, never the investigation log, so it has no evidence anchors to interpolate.
export function reviewEvents({ caseId, caseSlug, sessionId, turnIds, model, at }) {
  const s = makeStream({ caseId, caseSlug, sessionId })
  const t = (h) => at(h)

  s.session(model, t(20.2))

  // ── Turn 1: check out the pull request and read it against the review skill. ──
  s.turn(turnIds[0])
  s.user(
    `## Review run — JiaweiHan88/HiveMindTest#4\n\n` +
      `Review the diff at its head across all layers: **security**, **correctness**, **tests** ` +
      `and **design conformance**.\n\n` +
      `Record each defect with \`append_finding\`, citing the diff by ` +
      `\`[<repo>/<path>:<line>]\`. Every finding needs a concrete failure scenario — no scenario, ` +
      `no finding.`,
    t(20),
    true
  )
  s.tool(
    'mcp__argus__workspace_checkout',
    `checked out JiaweiHan88/HiveMindTest#4 at its head\n` +
      `worktree: worktrees/hmt-HMT-1-burst-token-pr4\n` +
      `4 files changed: src/rateLimiter.js, src/auth.js, src/notes.js, src/__tests__/rateLimiter.test.js`,
    t(19.97)
  )
  s.tool(
    'Skill',
    `code-review (user tier — overrides the bundled skill)\n\n` +
      `Review in layers, hardest first: security, correctness, tests, design conformance.\n` +
      `A finding without a concrete failure scenario is an opinion — drop it.`,
    t(19.95)
  )
  s.tool(
    'Read',
    `hmt/src/auth.js lines ${CODE.authVerifyLegacy}-74\n\n` +
      `${CODE.authVerifyLegacy}  function verifyLegacy(req, legacyToken, logger) {\n` +
      `${CODE.authLeak - 1}    if (!safeEqual(hashToken(token), hashToken(legacyToken))) {\n` +
      `${CODE.authLeak}      logger.warn(\`admin request with an invalid legacy token: \${token}\`)`,
    t(19.92)
  )
  s.say(
    `Checked out and read. The comparison itself is fine — \`safeEqual\` hashes both sides and ` +
      `uses \`crypto.timingSafeEqual\` with a length pre-check [hmt/src/auth.js:${CODE.authSafeEqual}], ` +
      `so the obvious timing finding is not there.\n\n` +
      `The security defect is one line further on, in the failure path: the rejection warning ` +
      `interpolates the submitted token into the log message ` +
      `[hmt/src/auth.js:${CODE.authLeak}]. Every failed admin authentication writes a live ` +
      `credential to the log in plaintext — and the near-misses are exactly the ones worth ` +
      `stealing, because a typo'd deploy token is still a valid deploy token.\n\n` +
      `Working through correctness and tests next.`,
    t(19.88)
  )
  s.done(t(19.84), 31200, 1340, 0.204, 41200)

  // ── Turn 2: the layered findings. ──
  s.turn(turnIds[1])
  s.user('Record what you have across all four layers.', t(19.7))
  s.tool(
    'Read',
    `hmt/src/__tests__/rateLimiter.test.js lines 18-25\n\n` +
      `18  test('allows requests up to the limit', () => {\n` +
      `20    const rl = new RateLimiter({ limit: 3, windowMs: 1000, now: c.now })\n` +
      `${CODE.testLimit}    assert.strictEqual(rl.allow('a'), false)\n` +
      `25  })`,
    t(19.68)
  )
  s.tool(
    'mcp__argus__append_finding',
    `finding #3 recorded · layer: security · severity: critical\n` +
      `"Rejected admin token is written to the log in plaintext"`,
    t(19.65)
  )
  s.tool(
    'mcp__argus__append_finding',
    `finding #4 recorded · layer: correctness · severity: major\n` +
      `"Burst gate reads window position where the documented intent is client pacing"`,
    t(19.63)
  )
  s.tool(
    'mcp__argus__append_finding',
    `finding #5 recorded · layer: tests · severity: major\n` +
      `"No test exercises the burst path; the limit test passes only because its clock never advances"`,
    t(19.61)
  )
  s.tool(
    'mcp__argus__append_finding',
    `finding #6 recorded · layer: design-conformance · severity: minor\n` +
      `"Unrelated probe file src/notes.js shipped in the pull request"`,
    t(19.59)
  )
  s.say(
    `Four findings, one per layer.\n\n` +
      `| Layer | Severity | Where |\n|---|---|---|\n` +
      `| security | critical | \`auth.js:${CODE.authLeak}\` |\n` +
      `| correctness | major | \`rateLimiter.js:${CODE.rlPositionGate}\` |\n` +
      `| tests | major | \`__tests__/rateLimiter.test.js:${CODE.testLimit}\` |\n` +
      `| design-conformance | minor | \`notes.js:${CODE.notes}\` |\n\n` +
      `The tests one is worth a second look, because it is the reason this shipped. ` +
      `\`allows requests up to the limit\` builds a limiter with \`limit: 3\` and asserts the ` +
      `fourth request is refused [hmt/src/__tests__/rateLimiter.test.js:${CODE.testLimit}]. That ` +
      `assertion only holds because the test's injected clock never advances past the window ` +
      `midpoint — advance it and the fourth request is *granted* from the burst, which is the ` +
      `production behaviour. The suite has five tests and none of them enters the burst branch ` +
      `at all, so the defect in \`allow\` is invisible to CI.\n\n` +
      `That matches the failing job in the artifacts: \`expected 100 served, got 120\` ` +
      `[artifacts/ci/verify-b.log:6].`,
    t(19.55)
  )
  s.done(t(19.5), 34800, 1620, 0.246, 47600)

  // ── Turn 3: push the two that belong on the pull request. ──
  s.turn(turnIds[2])
  s.user('Push the security one and the burst one as review comments on the PR.', t(19.4))
  s.tool(
    'mcp__argus__push_finding_comment',
    `posted inline comment on JiaweiHan88/HiveMindTest#4\n` +
      `src/auth.js:${CODE.authLeak} → https://github.com/JiaweiHan88/HiveMindTest/pull/4#discussion_r2214870031`,
    t(19.38)
  )
  s.tool(
    'mcp__argus__push_finding_comment',
    `posted inline comment on JiaweiHan88/HiveMindTest#4\n` +
      `src/rateLimiter.js:${CODE.rlPositionGate} → https://github.com/JiaweiHan88/HiveMindTest/pull/4#discussion_r2214870194`,
    t(19.36)
  )
  s.say(
    `Both posted, anchored to the lines they are about.\n\n` +
      `I left the tests finding and the stray \`notes.js\` off the pull request — they are real, ` +
      `but they are review conversation rather than blocking line comments, and the two I pushed ` +
      `are the ones that should hold the merge.`,
    t(19.32)
  )
  s.done(t(19.28), 36100, 480, 0.089, 12400)

  return s.events
}
