import fs from 'node:fs'
import path from 'node:path'

const HMT_REPO = 'https://github.com/JiaweiHan88/HiveMindTest'

/**
 * Skills, references, memory, proposals and config.
 *
 * This module is the single biggest lever on how the Library and Proposals screens read,
 * because those screens are mostly *someone's writing*. The test fixture's one-line stubs
 * ("Be careful.") are structurally valid and completely unusable in a screenshot. Everything
 * here is written at the length and specificity a real team artifact would have.
 *
 * Provenance rule: content attributed to an upstream tier is copied from the real HiveMind
 * clone, never invented. The `hivemind` and `confluence` tier files are pinned to real commits,
 * so claiming a pin for content that was never at that commit would make Sync report
 * "up to date" against something that does not exist upstream. The knowledge this demo's own
 * narrative produces is therefore `team-knowledge` or `user` tier — which is also what it
 * honestly is: a thing this team learned on a case, not a thing it pulled from HiveMind.
 */

const HIVE_PINS = {
  skills: {
    'hive-log-triage': '1057187557996e3c741fbf0a019716305b3ae48e',
    'hive-regression-bisect': '54e0e6b3d04ec6fc38561a98a4b14424310ff17e'
  },
  references: {
    'hive-known-issues.md': '1057187557996e3c741fbf0a019716305b3ae48e',
    // Names the UPSTREAM path; install() flattens confluence/x.md → references/x.md on disk.
    'confluence/hive-adasis-profile.md': '113d0546fe6013f80df841dc636ec95852b6d72d'
  }
}

/** Mirrors fmBlock() in src/main/services/frontmatter.ts. */
function fmBlock(raw) {
  const m = raw.match(/^---\r?\n([\s\S]*?)\r?\n---\r?\n?/)
  return m ? { fm: m[1], body: raw.slice(m[0].length) } : null
}

/** Mirrors withFrontmatter(): keep every key not named in `entries`, then append `entries`. */
function withHiveFrontmatter(body, entries) {
  const block = fmBlock(body)
  const keep = block
    ? block.fm
        .split(/\r?\n/)
        .filter((l) => !Object.keys(entries).some((k) => l.startsWith(`${k}:`)))
    : []
  const lines = [...keep, ...Object.entries(entries).map(([k, v]) => `${k}: ${v}`)]
  return `---\n${lines.join('\n')}\n---\n${block ? block.body : body}`
}

function realHiveBody(repos, relPath) {
  const src = path.join(repos.hmtDir, 'references', relPath)
  if (!fs.existsSync(src)) {
    throw new Error(`demo seed requires references/${relPath} in the clone (${repos.hmtDir})`)
  }
  return fs.readFileSync(src, 'utf8')
}

function frontmatter(entries) {
  return ['---', ...Object.entries(entries).map(([k, v]) => `${k}: ${v}`), '---', ''].join('\n')
}

// ── The flywheel artifact: what HMT-9 taught, in the form the flagship reused. ──
const RATE_LIMIT_PATTERNS = `# Rate limiting — patterns and failure modes

What we have learned running fixed-window limiters in the tile and quota services. Written
after HMT-9 (quota drift at window boundaries); extended on every case since.

## Position is not pacing

A window-position check — "are we near the end of the window?" — is a proxy for the thing you
actually want, which is "did this client pace itself across the window?".

It is a proxy that **inverts under load**. A client that spends its whole limit in the first
few seconds is, by the time the midpoint passes, *maximally* far past the midpoint. So a gate
written as \`resetsIn(client) >= windowMs / 2\` grants its most generous treatment to its worst
caller, while a client that genuinely paced itself and arrives late gets the same treatment it
would have got anyway.

The two conditions agree for well-behaved clients, which is why this survives review: every
example anyone reaches for while reading the diff is one where the proxy is correct.

**How to check.** Find the gate. Ask what state it reads. If the module has no record of *when*
the client hit its limit, it cannot be evaluating pacing, whatever the comment above it says.

## Effective cap, not configured cap

Whenever a limiter has a burst, the number to reason about is \`limit + burst\`, not \`limit\`.
Write it down in the review. Every burst bug we have had is someone assuming the configured
limit is the cap that holds under adversarial traffic.

## Boundary straddling

A fixed-window counter that resets on a wall-clock boundary while requests are in flight lets a
client straddling the boundary spend part of two windows — the HMT-9 signature. Effective quota
across the pair is \`limit + inflight\`.

## Signatures to grep for

| Signature | Usually means |
|---|---|
| \`served=N/M\` where N > M | burst granted where it should not have been |
| \`reason=past-window-midpoint\` | a position gate fired; check what it was standing in for |
| \`reason=upstream-saturated\` on a low-count client | someone else's burst is starving this one |
| counter reset with requests in flight | boundary straddling |
`

/**
 * The reference exactly as it lands on disk, frontmatter included.
 *
 * Shared with the pending reference-edit proposal below, which MUST carry the full intended
 * file content rather than just its new section: acceptProposal's reference branch does a
 * wholesale `fs.writeFileSync(destFile, body)` (proposals.ts) — it replaces, it does not
 * append. A proposal holding only the new section would therefore delete the rest of the
 * reference on accept, and ProposalsPage renders exactly that: it diffs `current` (the raw
 * on-disk file) against the proposal body, so the reviewer sees the whole reference struck
 * through in red. Building both from this one constant makes the diff pure additions, which is
 * both what the screenshot should show and what accepting actually does.
 *
 * Note this is NOT how memory-append behaves — that one really does append (applyMemoryWrite),
 * and renders as markdown rather than a diff, so those proposals carry only their new lesson.
 */
const RATE_LIMIT_PATTERNS_FILE =
  frontmatter({
    trust_tier: 'team-knowledge',
    title: 'Rate limiting — patterns and failure modes'
  }) + RATE_LIMIT_PATTERNS

/** The section the flagship's distill run proposes adding. */
const BURST_SIGNATURE_SECTION = `
## Signature: burst granted to a flood client

\`\`\`
WARN [client=X] window limit reached count=100/100 elapsed_ms=4021 remaining_ms=55979
INFO [client=X] burst allowance granted burst=20 window_elapsed_ms=30014 reason=past-window-midpoint
WARN [client=X] burst exhausted served=120/100 effective_cap=120
\`\`\`

Read \`elapsed_ms\` on the "limit reached" line. If it is small relative to the window, the
client did not pace itself and the later grant is the position/pacing inversion.

Correlate with a \`reason=upstream-saturated\` refusal for a low-count client in the same second
— that is the client the burst was supposed to protect.
`

const GLOSSARY = `# Glossary

**Burst allowance** — a number of requests a client may spend *beyond* the window limit. The
cap that actually holds under adversarial traffic is therefore \`limit + burst\`, not \`limit\`.

**Effective cap** — \`limit + burst\`. The number to use in any capacity or abuse calculation.

**Fixed window** — a limiter that counts requests inside a wall-clock interval and resets at the
boundary, as opposed to a sliding window or token bucket. Cheap, and prone to boundary effects.

**Pacing** — whether a client spread its requests across its window. Distinct from **window
position**, which is merely how much of the window remains. Conflating the two is our most
frequently repeated limiter bug (see \`rate-limit-patterns.md\`).

**Window position** — how far through its window a client currently is. Cheap to compute from
\`openedAt\` alone, which is exactly why it gets substituted for pacing.
`

const TILE_ENDPOINTS = `# Tile endpoints

Reference for the tile service's public surface. Bundled with Argus; no frontmatter, no tier.

| Endpoint | Method | Auth | Notes |
|---|---|---|---|
| \`/tile/{z}/{x}/{y}\` | GET | none | Rate limited per client id |
| \`/tile/meta\` | GET | none | Cache-warm status, not rate limited |
| \`/admin/flush\` | POST | \`x-api-token\` | Drops the tile cache |
| \`/admin/limits\` | GET | \`x-api-token\` | Echoes the live limiter config |

Rate limiting applies per client id, not per IP. The client id is taken from the
\`x-client-id\` header and falls back to the token subject when absent.
`

// ── User-tier skills. `code-review` deliberately shadows the bundled skill of the same name. ──
const USER_SKILLS = [
  {
    name: 'code-review',
    body: `---
name: code-review
description: Use when reviewing a diff or pull request. Reviews in layers, hardest first, and requires a concrete failure scenario for every finding.
---

# Code review

Review in layers, hardest first. Do not interleave them — the cheap layers will otherwise eat
the attention the expensive ones need.

## Layers

1. **Security.** Credentials, authentication and authorisation paths, anything written to a log
   or an error message, anything crossing a trust boundary. Read the *failure* paths, not just
   the success path — that is where secrets leak.
2. **Correctness.** For each conditional the diff adds or changes: what state does it read, and
   is that the state the surrounding comment claims it reads? Mismatches between a comment's
   stated intent and a gate's actual condition are the highest-yield bug class we have.
3. **Tests.** For each behaviour the diff changes, is there a test that would fail without the
   change? A passing test that never enters the branch under review is worse than no test — it
   buys confidence it has not earned.
4. **Design conformance.** Does this belong in this change at all? Unrelated files, drive-by
   refactors, and probe/debug leftovers.

## The rule for findings

**A finding without a concrete failure scenario is an opinion.** Write the scenario as inputs
and observed outcome — "a client that spends its limit in the first four seconds receives 20
more requests at the midpoint", not "the burst logic may be incorrect". If you cannot construct
the scenario, either you have not understood the code or there is no defect. Both mean: do not
record it.

## Citations

Anchor every finding to \`[<repo>/<path>:<line>]\`. A reviewer must be able to click straight to
the line. If a claim spans several places, cite the one that would change if the defect were
fixed.

## What not to record

- Style the formatter already owns.
- Restatements of the diff with no consequence attached.
- Speculation about code the diff does not touch — unless the diff makes it newly reachable.
`
  },
  {
    name: 'rate-limit-review',
    body: `---
name: rate-limit-review
description: Use when reviewing or triaging a rate limiter, quota, throttle or burst allowance. Distilled from HMT-9 (quota drift) and HMT-1 (burst allowance).
roles: [review, investigation]
---

# Reviewing a rate limiter

Distilled from two cases that turned out to be the same bug wearing different clothes.

## Ask these in order

1. **What is the effective cap?** Not the configured limit — \`limit + burst\`. Every capacity
   or abuse argument has to use that number.
2. **What state does the gate actually read?** Find the conditional that grants the burst or
   the exemption. List the fields it touches. Then read the comment above it and check the
   comment describes those fields.
3. **Does the module record when the limit was reached?** If it does not, it cannot gate on
   pacing, no matter what the documentation says. A gate derived only from \`openedAt\` is a
   position check.
4. **What happens at the window boundary with requests in flight?** Straddling gives a client
   part of two windows.
5. **Who is starved when the burst is spent?** The burst is normally justified by protecting
   some client. Check that client is not the one paying for it.

## The inversion

A window-position check reads as a reasonable proxy for pacing, and for well-behaved clients it
is one. Under adversarial traffic it inverts: the client that burned its limit fastest is the
one furthest past the midpoint, so it collects the most generous treatment the gate can give.

See \`references/rate-limit-patterns.md\` for the longer write-up and the log signatures.

## Tests to demand

A limiter test suite that never advances its injected clock past the burst threshold has not
tested the burst. Ask for a case that advances the clock to just past the midpoint after the
limit is exhausted and asserts the request is **refused** for a client that did not pace itself.
`
  }
]

/**
 * Pending proposals are what the Proposals screen shows; archived ones are the labelled corpus
 * the distill feedback loop exports. Both need real bodies for the same reason as skills.
 */
export function buildProposals(ctx) {
  const d = (h) => ctx.at(h).slice(0, 10)
  const P = ctx.T.PROPOSALS
  const A = ctx.T.PRIOR_CLOSED
  return [
    {
      file: `${d(P)}-HMT-1-burst-token-window-boundary-math.md`,
      type: 'skill-new',
      target: 'window-boundary-math',
      caseSlug: 'HMT-1-burst-token',
      title: 'Reason about burst allowances and window boundaries',
      hoursAgo: P,
      content: `---
name: window-boundary-math
description: Use when a limiter, quota or throttle grants an allowance conditional on where the client is in its window.
---

# Window boundary math

When an allowance is granted conditionally, write the condition out as arithmetic before
reading the code, then check the code computes that.

## The two conditions people confuse

- **Position**: \`resetsIn(client) < windowMs / 2\` — how much of the window remains. Derivable
  from \`openedAt\` alone.
- **Pacing**: \`limitReachedAt > windowStart + windowMs / 2\` — whether the client took most of
  the window to exhaust its limit. Requires state the module usually does not keep.

Position is cheap and looks like pacing. It is not: for a client that exhausted its limit
immediately, position is maximally satisfied exactly when pacing is maximally violated.

## Procedure

1. Write down the effective cap: \`limit + burst\`.
2. Find the gate. List the fields it reads.
3. If \`limitReachedAt\` (or equivalent) is not among them, the gate cannot be evaluating pacing.
4. Construct the adversarial client: exhaust the limit at \`t = 0\`, then request again at
   \`t = windowMs / 2 + ε\`. Work out what the gate returns.
5. Compare with the documented intent.

## Worked example — HMT-1

Config: \`limit=100 burst=20 windowMs=60000\`, gate \`resetsIn(c) >= windowMs / 2 → refuse\`.
A client spends 100 requests in 4021ms. At 30014ms elapsed, \`resetsIn\` = 29986 < 30000, so the
gate falls through and the burst is granted. Observed: \`served=120/100 effective_cap=120\`.
`,
      status: 'pending',
      rejectTag: null,
      rejectNote: null,
      jobId: null,
      previouslyReviewed: false
    },
    {
      file: `${d(P)}-HMT-1-burst-token-rate-limit-patterns.md`,
      type: 'reference-edit',
      target: 'rate-limit-patterns.md',
      caseSlug: 'HMT-1-burst-token',
      title: 'Add the burst-grant log signature from HMT-1',
      hoursAgo: P - 0.4,
      // Full intended file content, not just the new section — see RATE_LIMIT_PATTERNS_FILE.
      content: RATE_LIMIT_PATTERNS_FILE + BURST_SIGNATURE_SECTION,
      status: 'pending',
      rejectTag: null,
      rejectNote: null,
      jobId: null,
      previouslyReviewed: false
    },
    {
      file: `${d(P)}-HMT-1-burst-token-burst-window-math.md`,
      type: 'memory-append',
      target: 'burst-window-math',
      caseSlug: 'HMT-1-burst-token',
      title: 'Confirmed again: position gates invert under load',
      hoursAgo: P - 0.8,
      content: `Second confirmation (HMT-1, tile-service). A burst gated on \`resetsIn >= windowMs / 2\`
granted 20 extra requests to a client that had exhausted its limit in the first 4 seconds,
taking the effective cap to 120/100. The gate had no \`limitReachedAt\` state at all, so the
documented pacing intent was not merely unimplemented — it was unimplementable as written.
`,
      status: 'pending',
      rejectTag: null,
      rejectNote: null,
      jobId: null,
      previouslyReviewed: true
    },
    {
      file: `${d(P)}-HMT-1-burst-token-HMT-1-burst-token.md`,
      type: 'case-summary',
      target: 'HMT-1-burst-token',
      caseSlug: 'HMT-1-burst-token',
      title: 'Burst allowance gated on window position instead of client pacing',
      hoursAgo: P - 1.2,
      content: `The burst allowance was granted on window position (\`resetsIn >= windowMs / 2\`)
rather than on whether the client had paced its window, raising the effective cap to
\`limit + burst\` for exactly the clients the allowance was meant to exclude.
`,
      status: 'pending',
      rejectTag: null,
      rejectNote: null,
      jobId: '2',
      previouslyReviewed: false,
      summaryJson: JSON.stringify({
        signature: 'burst allowance granted on window position rather than client pacing',
        symptoms:
          'One client served 120 requests against a configured limit of 100 in a single window, while paced clients received 429 upstream-saturated.',
        rootCause:
          'The burst gate read resetsIn() (window position) only; the module kept no record of when the limit was reached, so the documented pacing condition was unimplementable as written.',
        fix: 'Record limitReachedAt on the bucket and gate the burst on that being late in the window; add a test that advances the clock past the midpoint.',
        keywords: ['rate-limit', 'burst', 'window', 'pacing', 'position', 'effective-cap']
      }),
      resolution: 'solved'
    },
    // ── Archive: the labelled corpus. ──
    {
      file: `${d(A)}-HMT-9-quota-drift-burst-window-math.md`,
      type: 'memory-append',
      target: 'burst-window-math',
      caseSlug: 'HMT-9-quota-drift',
      title: 'Limiter gates expressed as window position invert under load',
      hoursAgo: A,
      content: `A limiter gate expressed in terms of where we are in the window, rather than what
the client has actually done, inverts under load: the worst client is the one furthest past the
boundary. Check what state the gate reads, not what its comment claims.
`,
      status: 'accepted',
      rejectTag: null,
      rejectNote: null,
      jobId: '1',
      previouslyReviewed: false
    },
    {
      file: `${d(A)}-HMT-9-quota-drift-rate-limit-patterns.md`,
      type: 'reference-edit',
      target: 'rate-limit-patterns.md',
      caseSlug: 'HMT-9-quota-drift',
      title: 'Start a rate-limiting patterns reference',
      hoursAgo: A - 0.5,
      content: `Position is not pacing; boundary straddling gives a client part of two windows.
`,
      status: 'accepted',
      rejectTag: null,
      rejectNote: null,
      jobId: '1',
      previouslyReviewed: false
    },
    {
      file: `${d(A)}-HMT-9-quota-drift-clock-skew-note.md`,
      type: 'memory-append',
      target: 'clock-skew-note',
      caseSlug: 'HMT-9-quota-drift',
      title: 'The 2h gap in quota logs is a timezone artifact',
      hoursAgo: A - 1,
      content: `The quota service logs local time while the tile service logs UTC, so a 2h gap
between their timestamps for the same request is an artifact, not latency.
`,
      status: 'accepted',
      rejectTag: null,
      rejectNote: null,
      jobId: '1',
      previouslyReviewed: false
    },
    {
      file: `${d(A)}-HMT-9-quota-drift-req-4471-note.md`,
      type: 'memory-append',
      target: 'req-4471-note',
      caseSlug: 'HMT-9-quota-drift',
      title: 'Request 4471 crossed the boundary',
      hoursAgo: A - 1.5,
      content: `Request 4471 was in flight when the counter reset.\n`,
      status: 'rejected',
      rejectTag: 'overfit',
      rejectNote: 'A single request id from one log is not a lesson.',
      jobId: '1',
      previouslyReviewed: false
    },
    {
      file: `${d(A)}-HMT-9-quota-drift-write-careful-code.md`,
      type: 'skill-new',
      target: 'write-careful-code',
      caseSlug: 'HMT-9-quota-drift',
      title: 'Write careful code',
      hoursAgo: A - 2,
      content: `---\nname: write-careful-code\ndescription: Always think carefully.\n---\n\nBe careful when writing code.\n`,
      status: 'rejected',
      rejectTag: 'overgeneric',
      rejectNote: 'Says nothing a reviewer could act on.',
      jobId: '1',
      previouslyReviewed: false
    },
    {
      file: `${d(A)}-HMT-9-quota-drift-counter-reset-note.md`,
      type: 'memory-append',
      target: 'counter-reset-note',
      caseSlug: 'HMT-9-quota-drift',
      title: 'Counter resets are atomic',
      hoursAgo: A - 2.5,
      content: `The window counter reset is atomic, so in-flight requests cannot straddle it.\n`,
      status: 'rejected',
      rejectTag: 'wrong',
      rejectNote:
        'Directly contradicted by the evidence — quota-drift.log shows 14 requests in flight across the reset.',
      jobId: '1',
      previouslyReviewed: false
    },
    {
      file: `${d(A)}-HMT-9-quota-drift-boundary-note-2.md`,
      type: 'memory-append',
      target: 'burst-window-math',
      caseSlug: 'HMT-9-quota-drift',
      title: 'Window boundaries need a pacing check',
      hoursAgo: A - 3,
      content: `Same lesson as the accepted burst-window-math item.\n`,
      status: 'rejected',
      rejectTag: 'duplicate',
      rejectNote: null,
      jobId: '1',
      previouslyReviewed: false
    },
    {
      file: `${d(A)}-HMT-3-cancelled-ci-note.md`,
      type: 'memory-append',
      target: 'ci-note',
      caseSlug: 'HMT-3-cancelled',
      title: 'CI was red',
      hoursAgo: A - 3.5,
      content: `The pull request was red.\n`,
      status: 'rejected',
      rejectTag: 'other',
      rejectNote: 'Case state, not knowledge.',
      jobId: '1',
      previouslyReviewed: false
    }
  ]
}

/** Frontmatter keys match the REAL readers: `job` (not job_id), `reject_reason` (not tag). */
export function writeProposalFile(dir, p, ctx) {
  const fm = {
    type: p.type,
    target: p.target,
    case: p.caseSlug,
    date: ctx.at(p.hoursAgo),
    title: p.title,
    status: p.status
  }
  if (p.jobId) fm.job = p.jobId
  if (p.previouslyReviewed) fm.previously_reviewed = 'true'
  if (p.rejectTag) fm.reject_reason = p.rejectTag
  if (p.rejectNote) fm.reject_note = p.rejectNote
  if (p.summaryJson) fm.summary_json = p.summaryJson
  if (p.resolution) fm.resolution = p.resolution
  fs.writeFileSync(path.join(dir, p.file), frontmatter(fm) + p.content, 'utf8')
}

/** First-generation-wins backup, so a re-seed never replaces the user's original with our own. */
export function writeConfigFile(cfgDir, name, body) {
  const backupDir = path.join(cfgDir, '.seed-backup')
  const dest = path.join(cfgDir, name)
  const backupDest = path.join(backupDir, name)
  if (fs.existsSync(dest) && !fs.existsSync(backupDest)) {
    fs.mkdirSync(backupDir, { recursive: true })
    fs.copyFileSync(dest, backupDest)
  }
  fs.writeFileSync(dest, body, 'utf8')
}

export function seedKnowledge(ctx, { repos }) {
  const home = ctx.argusHome
  const now = ctx.nowIso()

  // ── Proposals ──
  const pDir = path.join(home, 'proposals')
  const aDir = path.join(pDir, 'archive')
  fs.rmSync(pDir, { recursive: true, force: true })
  fs.mkdirSync(aDir, { recursive: true })
  const proposals = buildProposals(ctx)
  let pending = 0
  let archived = 0
  for (const p of proposals) {
    if (p.status === 'pending') {
      writeProposalFile(pDir, p, ctx)
      pending++
    } else {
      writeProposalFile(aDir, p, ctx)
      archived++
    }
  }

  // ── Skills. Resolution precedence is user > hivemind > bundled, and it comes from the
  //    DIRECTORY, not frontmatter (agent/skillsResolver.ts). `code-review` collides with a
  //    bundled skill on purpose so the Library's "overrides" chip is populated. ──
  const userDir = path.join(home, 'skills-user')
  const hiveDir = path.join(home, 'skills-hivemind')
  fs.rmSync(userDir, { recursive: true, force: true })
  fs.rmSync(hiveDir, { recursive: true, force: true })

  let hiveSkills = 0
  for (const name of Object.keys(HIVE_PINS.skills)) {
    const src = path.join(repos.hmtDir, 'skills', name, 'SKILL.md')
    if (!fs.existsSync(src)) throw new Error(`demo seed requires skills/${name}/SKILL.md in clone`)
    const dest = path.join(hiveDir, name)
    fs.mkdirSync(dest, { recursive: true })
    fs.copyFileSync(src, path.join(dest, 'SKILL.md'))
    hiveSkills++
  }
  for (const s of USER_SKILLS) {
    const dest = path.join(userDir, s.name)
    fs.mkdirSync(dest, { recursive: true })
    fs.writeFileSync(path.join(dest, 'SKILL.md'), s.body, 'utf8')
  }

  // ── References across the tiers. `bundled` carries no frontmatter; the rest declare one. ──
  const refDir = path.join(home, 'references')
  fs.rmSync(refDir, { recursive: true, force: true })
  fs.mkdirSync(refDir, { recursive: true })
  const refs = [
    { file: 'tile-endpoints.md', body: TILE_ENDPOINTS },
    {
      file: 'glossary.md',
      body: frontmatter({ trust_tier: 'user', title: 'Glossary' }) + GLOSSARY
    },
    {
      // The flywheel artifact. team-knowledge, not hivemind: this team wrote it on HMT-9.
      // Same constant the pending reference-edit proposal builds on, so that proposal's diff
      // is pure additions rather than a full-file replacement.
      file: 'rate-limit-patterns.md',
      body: RATE_LIMIT_PATTERNS_FILE
    },
    {
      file: 'hive-known-issues.md',
      body: withHiveFrontmatter(realHiveBody(repos, 'hive-known-issues.md'), {
        trust_tier: 'hivemind',
        source_repo: HMT_REPO,
        source_commit: HIVE_PINS.references['hive-known-issues.md']
      })
    },
    {
      // Written FLAT: install() flattens confluence/x.md → references/x.md, and the
      // installed-state probe checks the flat basename.
      file: 'hive-adasis-profile.md',
      body: withHiveFrontmatter(realHiveBody(repos, 'confluence/hive-adasis-profile.md'), {
        trust_tier: 'confluence',
        source_repo: HMT_REPO,
        source_commit: HIVE_PINS.references['confluence/hive-adasis-profile.md']
      })
    }
  ]
  for (const r of refs) fs.writeFileSync(path.join(refDir, r.file), r.body, 'utf8')

  // ── Memory ──
  const memDir = path.join(home, 'memory')
  fs.rmSync(memDir, { recursive: true, force: true })
  fs.mkdirSync(memDir, { recursive: true })
  const memories = [
    {
      topic: 'burst-window-math',
      caseSlug: 'HMT-9-quota-drift',
      hoursAgo: ctx.T.PRIOR_CLOSED,
      summary: 'position gates invert under load; check what state the gate reads',
      body: `# burst-window-math

A limiter gate expressed in terms of WINDOW POSITION rather than what the client has actually
done inverts under load: the client that exhausted its limit fastest is the one furthest past
the midpoint, so it collects the most generous treatment the gate can give.

Check what state the gate reads, not what its comment claims. If the module keeps no record of
when the limit was reached, it cannot be gating on pacing.

Effective cap is \`limit + burst\`, never \`limit\`.
`
    },
    {
      topic: 'clock-skew-note',
      caseSlug: 'HMT-9-quota-drift',
      hoursAgo: ctx.T.PRIOR_CLOSED - 1,
      summary: 'quota service logs local time, tile service logs UTC',
      body: `# clock-skew-note

The quota service logs local time while the tile service logs UTC. A 2h gap between their
timestamps for the same request is an artifact of that, not latency.
`
    },
    {
      topic: 'tile-cache-cold-boot',
      caseSlug: 'HMT-9-quota-drift',
      hoursAgo: ctx.T.PRIOR_CLOSED - 2,
      summary: 'route timeout on cold boot reproduces only with an empty tile cache',
      body: `# tile-cache-cold-boot

\`route calculation timeout\` on cold boot reproduces only when the tile cache is empty: the
warm-up races the first route request. Compare the first-request timestamp against the
cache-ready line before looking anywhere else.
`
    }
  ]
  for (const m of memories) fs.writeFileSync(path.join(memDir, `${m.topic}.md`), m.body, 'utf8')
  // Index lines are markdown links — memory.ts's indexLineFor/filteredIndex match `(<topic>.md)`.
  // No heading: applyMemoryWrite never emits one, and a heading would survive the disabled-topic
  // filter and be injected into the agent verbatim.
  fs.writeFileSync(
    path.join(memDir, '_index.md'),
    `${memories.map((m) => `- [${m.topic}](${m.topic}.md) — ${m.summary}`).join('\n')}\n`,
    'utf8'
  )
  fs.writeFileSync(
    path.join(memDir, '.audit.jsonl'),
    `${memories
      .map((m) =>
        JSON.stringify({
          ts: ctx.at(m.hoursAgo),
          caseSlug: m.caseSlug,
          topic: m.topic,
          indexEntry: m.summary,
          bytes: Buffer.byteLength(m.body, 'utf8')
        })
      )
      .join('\n')}\n`,
    'utf8'
  )

  // ── Config ──
  const cfgDir = path.join(home, 'config')
  fs.mkdirSync(cfgDir, { recursive: true })

  writeConfigFile(
    cfgDir,
    'hivemind-state.json',
    `${JSON.stringify(
      {
        lastSynced: ctx.at(ctx.T.CREATED),
        skills: HIVE_PINS.skills,
        references: HIVE_PINS.references,
        pushes: {}
      },
      null,
      2
    )}\n`
  )
  writeConfigFile(
    cfgDir,
    'settings.json',
    // onboarding must read as completed, or a first-run overlay covers every screenshot.
    `${JSON.stringify(
      {
        agent: {
          activeInstanceId: 'claude-agent-sdk-1',
          maxSessions: 2,
          providerInstances: {
            'claude-agent-sdk-1': { driver: 'claude-agent-sdk', enabled: true, config: {} },
            'github-copilot-1': { driver: 'github-copilot', enabled: true, config: {} },
            'codex-1': { driver: 'codex', enabled: true, config: {} }
          },
          modelPreferences: {
            'claude-agent-sdk-1': {
              hiddenModels: [],
              favoriteModels: ['claude-opus-5'],
              modelOrder: []
            }
          }
        },
        hivemind: { repo: HMT_REPO },
        onboarding: { completedAt: ctx.at(ctx.T.PRIOR_WORK), phase1Done: true, tourDone: true },
        memoryHygiene: { trackingStartedAt: ctx.at(ctx.T.PRIOR_WORK) }
      },
      null,
      2
    )}\n`
  )
  // Nothing disabled: a demo home should show its knowledge switched on. (The test fixture
  // disables one of each to prove the override works; that is its job, not this one's.)
  writeConfigFile(
    cfgDir,
    'agent-access.json',
    `${JSON.stringify({ skills: {}, memory: {} }, null, 2)}\n`
  )
  writeConfigFile(
    cfgDir,
    'tool-risk.json',
    `${JSON.stringify({ 'rovo/getJiraIssue': 'high' }, null, 2)}\n`
  )

  return {
    proposals: pending,
    archived,
    userSkills: USER_SKILLS.length,
    hiveSkills,
    references: refs.length,
    memories: memories.length,
    now
  }
}
