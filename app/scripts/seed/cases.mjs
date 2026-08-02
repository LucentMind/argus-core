import fs from 'node:fs'
import path from 'node:path'

const TITLES = {
  'HMT-1-burst-token': 'Burst allowance and legacy deploy-script tokens',
  'HMT-2-green': 'Green rollup fixture',
  'HMT-3-cancelled': 'Cancelled verify job on a red pull request',
  'HMT-4-nochecks': 'Public-endpoint auth skip (no CI configured)',
  'SYN-5-edge': 'Synthetic edge-case pull request'
}

/** Every real case shares the fixture's one Jira ticket; SYN-5-edge is fabricated
 *  (no linked repo history, no real PR) and must not claim a real ticket. */
function jiraKeyFor(slug) {
  return slug === 'SYN-5-edge' ? null : 'HMT-1'
}

/** Verbatim mirror of `CASE_WORKING_RULES` in `app/src/main/services/caseService.ts`
 *  (the seed script can't import that .ts module, so this is kept in sync by hand —
 *  update both if the real template changes). Appended to every seeded CLAUDE.md so
 *  the fixture's model-facing instructions match a real case's exactly. */
const CASE_WORKING_RULES = `## Working rules

- Cite evidence as \`[<rel-path>:<line>]\` for every claim based on evidence, e.g. \`[evidence/app.log:812]\`.
- Record findings with the \`mcp__argus__append_finding\` tool — never edit \`findings.md\` directly.
- Search evidence with \`mcp__argus__search_evidence\` before grepping files.
- To inspect a linked repo at a branch/PR/tag, call \`mcp__argus__workspace_checkout\` — never \`git switch\`/\`checkout\` in the primary checkout.
- Register derived files you create as evidence via \`mcp__argus__ingest_artifact\` so they become searchable and citable.
`

/**
 * (Re)create the machine-local `.claude` junctions (skills, references).
 * Mirror of `scaffoldCaseLinks` in `app/src/main/services/caseService.ts` — the case
 * dir's `.claude` is the skill plugin root, so without it a chat opened in a seeded
 * case cannot resolve skills. Idempotent; only creates a link when it is missing and
 * its target exists.
 */
function scaffoldCaseLinks(argusHome, dir) {
  const dotClaude = path.join(dir, '.claude')
  fs.mkdirSync(dotClaude, { recursive: true })
  for (const [name, target] of [
    ['skills', path.join(argusHome, 'skills')],
    ['references', path.join(argusHome, 'references')]
  ]) {
    const link = path.join(dotClaude, name)
    // 'dir' symlinks need elevation on Windows; junctions don't and lstat still
    // reports them as symbolic links.
    const linkType = process.platform === 'win32' ? 'junction' : 'dir'
    if (!fs.existsSync(link) && fs.existsSync(target)) fs.symlinkSync(target, link, linkType)
  }
}

/** Sessions per case: the flagship gets four across three drivers, thin cases one. */
function sessionPlan(slug) {
  if (slug !== 'HMT-1-burst-token') {
    return [
      {
        mode: 'review',
        driver: 'claude-agent-sdk',
        instance: 'claude-agent-sdk-1',
        model: 'claude-opus-5',
        title: 'review run'
      }
    ]
  }
  return [
    {
      mode: 'investigation',
      driver: 'claude-agent-sdk',
      instance: 'claude-agent-sdk-1',
      model: 'claude-sonnet-5',
      title: 'triage the timeout'
    },
    {
      mode: 'investigation',
      driver: 'github-copilot',
      instance: 'github-copilot-1',
      model: 'auto',
      title: 'log sweep'
    },
    {
      mode: 'review',
      driver: 'claude-agent-sdk',
      instance: 'claude-agent-sdk-1',
      model: 'claude-opus-5',
      title: 'layered review'
    },
    {
      mode: 'review',
      driver: 'codex',
      instance: 'codex-1',
      model: 'gpt-5-codex',
      title: 'second opinion'
    }
  ]
}

const TOOL_CALLS = [
  { tool: 'Read', risk: 'LOW', decision: 'auto', detail: null },
  { tool: 'Bash', risk: 'HIGH', decision: 'user', detail: null },
  { tool: 'Bash', risk: 'HIGH', decision: 'denied', detail: null },
  { tool: 'Skill', risk: 'LOW', decision: 'observed', detail: 'code-review' },
  { tool: 'mcp__argus__read_memory', risk: 'LOW', decision: 'auto', detail: 'burst-window-math' },
  // There is no mcp__argus__read_reference tool anywhere in src/. Real reference
  // attribution comes from a taxonomy fs-read tool (Read/Glob/Grep/NotebookRead) whose
  // path resolves inside the shared references dir — extractToolDetail() (toolDetail.ts)
  // then stores `ref:<relpath>`, and the usage query (observability/usage.ts) counts
  // rows via `detail LIKE 'ref:%'`. Match that shape so the References usage panel is
  // non-empty against a seeded home.
  {
    tool: 'Read',
    risk: 'LOW',
    decision: 'grant',
    detail: 'ref:hive-known-issues.md'
  },
  { tool: 'Edit', risk: 'MEDIUM', decision: 'user', detail: null }
]

export function seedCases(ctx, { repos }) {
  const now = ctx.nowIso()
  const caseIds = {}
  const sessionIds = {}

  for (const slug of ctx.SLUGS) {
    // Deleting the case cascades to sessions/turns/tool_calls/findings/bindings/
    // pr_bindings/pr_status_cache/evidence — every table with an FK to cases(id).
    //
    // It does NOT reach case_summaries or distill_jobs: both are keyed by case_slug
    // with NO foreign key to cases(id) at all (case_slug is a plain TEXT column, not
    // a reference), so a `DELETE FROM cases` cascade never touches them. The app's own
    // deleteCase() (caseService.ts) deletes both explicitly inside the same
    // transaction as the cases row — mirrored below for the same reason.
    //
    // It also does NOT reach messages_fts/messages_fts_map or evidence_fts/evidence_fts_map:
    // the _fts tables are FTS5 virtual tables and the _map side tables are plain
    // tables, and neither carries a foreign key to cases (see ftsIndex.ts). Left
    // alone, re-running the seed would leave the previous run's chat-search rows
    // behind (duplicate hits) plus map rows pointing at session/evidence ids that no
    // longer exist. The evidence side is not hypothetical: the documented fixture
    // workflow is seed -> boot -> Rescan (which writes evidence + evidence_fts +
    // evidence_fts_map) -> possibly re-seed, so a second seed run will reliably hit
    // evidence FTS rows the seed itself never wrote.
    //
    // Mirror caseService.ts's deleteCase(): clear the FTS rows BEFORE the cascade,
    // resolving each row's rowid through its map table (FTS5 only addresses a row
    // cheaply by `rowid = ?` — deleting by the UNINDEXED key column scans the whole
    // index) and delete each by rowid. Do this here (not by importing deleteCase, a
    // TypeScript module this .mjs script cannot import) so it fires whether or not
    // the case row already existed.
    const priorCase = ctx.db.prepare('SELECT id FROM cases WHERE slug = ?').get(slug)
    if (priorCase) {
      const priorCaseId = priorCase.id
      const msgFtsRows = ctx.db
        .prepare('SELECT fts_rowid FROM messages_fts_map WHERE case_id = ?')
        .all(priorCaseId)
      const delMsgFts = ctx.db.prepare('DELETE FROM messages_fts WHERE rowid = ?')
      for (const r of msgFtsRows) delMsgFts.run(r.fts_rowid)
      ctx.db.prepare('DELETE FROM messages_fts_map WHERE case_id = ?').run(priorCaseId)

      const evFtsRows = ctx.db
        .prepare(
          `SELECT fts_rowid FROM evidence_fts_map
           WHERE evidence_id IN (SELECT id FROM evidence WHERE case_id = ?)`
        )
        .all(priorCaseId)
      const delEvFts = ctx.db.prepare('DELETE FROM evidence_fts WHERE rowid = ?')
      for (const r of evFtsRows) delEvFts.run(r.fts_rowid)
      ctx.db
        .prepare(
          `DELETE FROM evidence_fts_map
           WHERE evidence_id IN (SELECT id FROM evidence WHERE case_id = ?)`
        )
        .run(priorCaseId)
    }
    ctx.db.prepare('DELETE FROM cases WHERE slug = ?').run(slug)
    // Not covered by the cases cascade (see the comment above) — delete explicitly,
    // same as deleteCase() does, rather than relying on seedDistill's later global wipe.
    ctx.db.prepare('DELETE FROM case_summaries WHERE case_slug = ?').run(slug)
    ctx.db.prepare('DELETE FROM case_summaries_fts WHERE case_slug = ?').run(slug)
    ctx.db.prepare('DELETE FROM distill_jobs WHERE case_slug = ?').run(slug)
    fs.rmSync(ctx.caseDir(slug), { recursive: true, force: true })
    // deleteCase() also removes the case's dev-tools prompt capture directory; a
    // prior run's captured prompts must not re-attach to a freshly reseeded case of
    // the same slug.
    fs.rmSync(path.join(ctx.argusHome, '.dev-prompts', slug), { recursive: true, force: true })

    const workspaces =
      slug === 'SYN-5-edge'
        ? [{ path: repos.syntheticDir.replace(/\\/g, '/'), remote: null, branch: 'main' }]
        : [
            {
              path: repos.hmtDir.replace(/\\/g, '/'),
              remote: 'https://github.com/JiaweiHan88/HiveMindTest.git',
              branch: 'main'
            }
          ]

    const jiraKey = jiraKeyFor(slug)
    ctx.db
      .prepare(
        `INSERT INTO cases (slug, title, jira_key, status, tags, workspaces, active_mode, created_at, updated_at)
         VALUES (?, ?, ?, ?, '[]', ?, 'review', ?, ?)`
      )
      .run(slug, TITLES[slug], jiraKey, 'open', JSON.stringify(workspaces), now, now)
    const caseId = ctx.db.prepare('SELECT id FROM cases WHERE slug = ?').get(slug).id
    caseIds[slug] = caseId

    const dir = ctx.caseDir(slug)
    fs.mkdirSync(path.join(dir, 'sessions'), { recursive: true })
    fs.mkdirSync(path.join(dir, 'evidence'), { recursive: true })
    fs.mkdirSync(path.join(dir, 'artifacts'), { recursive: true })
    scaffoldCaseLinks(ctx.argusHome, dir)

    const insSession = ctx.db.prepare(
      `INSERT INTO sessions (case_id, driver_kind, instance_id, model, title, turn_count, created_at, updated_at, mode)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`
    )
    const insTurn = ctx.db.prepare(
      `INSERT INTO turns (case_id, session_id, turn_index, status, input_tokens, output_tokens, cost_usd, duration_ms, model, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
    )
    const insTool = ctx.db.prepare(
      `INSERT INTO tool_calls (case_id, session_id, turn_id, tool, args_hash, risk, decision, duration_ms, detail, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
    )
    const insFts = ctx.db.prepare(
      `INSERT INTO messages_fts (content, case_id, session_id, turn_id, role) VALUES (?, ?, ?, ?, ?)`
    )
    const insFtsMap = ctx.db.prepare(
      `INSERT INTO messages_fts_map (fts_rowid, case_id, session_id) VALUES (?, ?, ?)`
    )

    const byMode = {}
    for (const [i, plan] of sessionPlan(slug).entries()) {
      const r = insSession.run(
        caseId,
        plan.driver,
        plan.instance,
        plan.model,
        plan.title,
        2,
        now,
        now,
        plan.mode
      )
      const sessionId = Number(r.lastInsertRowid)
      byMode[plan.mode] = sessionId

      const statuses = ['success', i === 1 ? 'error' : 'success']
      const turnIds = statuses.map((status, t) =>
        Number(
          insTurn.run(
            caseId,
            sessionId,
            t,
            status,
            4200 + t * 900,
            810 + t * 120,
            0.031 + t * 0.008,
            5400 + t * 1200,
            plan.model,
            now
          ).lastInsertRowid
        )
      )

      for (const [k, tc] of TOOL_CALLS.entries()) {
        insTool.run(
          caseId,
          sessionId,
          turnIds[k % turnIds.length],
          tc.tool,
          `hash-${slug}-${sessionId}-${k}`,
          tc.risk,
          tc.decision,
          120 + k * 45,
          tc.detail,
          now
        )
      }

      // Transcript mirror + chat-search rows. The FTS map row must carry the same
      // rowid the FTS insert produced, or per-session deletes cannot find it.
      const lines = [
        {
          role: 'user',
          text: `Review ${slug} — the burst allowance and the legacy token path.`
        },
        {
          role: 'assistant',
          text: `Read rateLimiter.js and auth.js. The burst is granted without checking when the limit was hit.`
        }
      ]
      const jsonl = lines
        .map((l, n) =>
          JSON.stringify({
            eventId: `seed-${sessionId}-${n}`,
            caseId,
            caseSlug: slug,
            sessionId,
            turnId: turnIds[Math.min(n, turnIds.length - 1)],
            ts: now,
            type: n === 0 ? 'turn.started' : 'turn.completed',
            payload: n === 0 ? { userText: l.text } : { assistantText: l.text }
          })
        )
        .join('\n')
      fs.writeFileSync(path.join(dir, 'sessions', `${sessionId}.jsonl`), `${jsonl}\n`, 'utf8')
      for (const [n, l] of lines.entries()) {
        const res = insFts.run(
          l.text,
          caseId,
          sessionId,
          turnIds[Math.min(n, turnIds.length - 1)],
          l.role
        )
        insFtsMap.run(Number(res.lastInsertRowid), caseId, sessionId)
      }
    }
    // Thin cases have no investigation session; point both keys at what exists so
    // seedFindings can look up either without a null session_id.
    //
    // For the flagship case, sessionPlan() above builds two 'investigation' and two
    // 'review' sessions, but byMode only keeps one id per mode — the loop's last
    // session of each mode wins, so the two earlier same-mode sessions (both, as it
    // happens, 'claude-agent-sdk' runs) get no findings attached. This is intentional,
    // not a gap: findings render by their session's mode, not the session's identity,
    // so which same-mode session a finding attaches to changes nothing on screen — all
    // four sessions still show up with their own driver/model chips, turns, tool calls
    // and transcript, and a session with zero findings is realistic (plenty of real
    // sessions produce none). Do not widen sessionIds[slug] to one entry per session;
    // that interface is shared with seedFindings (findings.mjs) and already shipped.
    sessionIds[slug] = {
      investigation: byMode.investigation ?? byMode.review,
      review: byMode.review
    }

    writeCaseJson(ctx, slug, { caseId, jiraKey, workspaces, now })
    writeCaseClaudeMd(ctx, slug, { jiraKey, workspaces, now, worktree: repos.worktrees[slug] })
  }

  return { caseIds, sessionIds }
}

/**
 * Mirror of `pinCasePhase` in `app/src/main/services/caseService.ts` (same "seed can't
 * import a .ts module" constraint as `CASE_WORKING_RULES` above). `rca-drafted` is the one
 * derived phase with no artifact of its own — everything else in shared/casePhase.ts falls
 * out of session/finding/PR-binding timestamps that seedCases/seedFindings/seedPrs already
 * write, so without this call it is never exercised by the fixture at all.
 *
 * A pin competes on `phase_pinned_at` against every other signal (see casePhase.ts), so this
 * must run after seedPrs — the pull-request binding it would otherwise lose to.
 */
export function pinCasePhase(ctx, { slug, pin }) {
  const now = ctx.nowIso()
  ctx.db
    .prepare(`UPDATE cases SET phase_pin = ?, phase_pinned_at = ?, updated_at = ? WHERE slug = ?`)
    .run(pin, now, now, slug)
  const file = path.join(ctx.caseDir(slug), 'case.json')
  const onDisk = JSON.parse(fs.readFileSync(file, 'utf8'))
  fs.writeFileSync(
    file,
    `${JSON.stringify({ ...onDisk, phasePin: pin, phasePinnedAt: now, updatedAt: now }, null, 2)}\n`,
    'utf8'
  )
}

/** Mirror of the DB record the app writes on every case update. */
function writeCaseJson(ctx, slug, { jiraKey, workspaces, now }) {
  const doc = {
    slug,
    title: TITLES[slug],
    jiraKey,
    jiraSyncedAt: null,
    jiraDeselected: [],
    jiraStatus: null,
    jiraPriority: null,
    jiraCommentCount: null,
    jiraAttachmentIds: [],
    reviewBaseline: null,
    lastSyncError: null,
    status: 'open',
    resolution: null,
    activeMode: 'review',
    tags: [],
    createdAt: now,
    updatedAt: now,
    actionItems: [],
    workspaces
  }
  fs.writeFileSync(
    path.join(ctx.caseDir(slug), 'case.json'),
    `${JSON.stringify(doc, null, 2)}\n`,
    'utf8'
  )
}

function writeCaseClaudeMd(ctx, slug, { jiraKey, workspaces, now, worktree }) {
  const pr = ctx.PR_NUMBERS[slug]
  const md = `# Case: ${slug}

- Title: ${TITLES[slug]}
- Jira: ${jiraKey ?? '(none)'}
- Opened: ${now}
- This directory is the case dir. Evidence lives in \`evidence/\`.

## Linked code workspaces

<!-- argus:workspaces -->
${workspaces.map((w) => `- \`${w.path}\` (linked at branch \`${w.branch}\`)`).join('\n')}
<!-- /argus:workspaces -->

## Linked pull requests

<!-- argus:prs -->
- \`JiaweiHan88/HiveMindTest#${pr}\` (https://github.com/JiaweiHan88/HiveMindTest/pull/${pr}) — checked out at \`${worktree.dir}\`
<!-- /argus:prs -->

${CASE_WORKING_RULES}`
  fs.writeFileSync(path.join(ctx.caseDir(slug), 'CLAUDE.md'), md, 'utf8')
}
