import fs from 'node:fs'
import path from 'node:path'
import { investigationEvents, reviewEvents } from './transcript.mjs'

/**
 * Case rows, sessions, turns, tool calls, transcripts and the case-dir mirror files.
 *
 * Phase is DERIVED, not stored (src/shared/casePhase.ts) — it is the phase of the case's newest
 * work signal. Every timestamp below is therefore chosen, not wall-clock, so each case lands on
 * the badge it is meant to demonstrate. `PHASE_INTENT` records which signal is supposed to win
 * on each case; if you change a timestamp, change that comment too or the next reader has no
 * way to know the badge moved.
 */

const CASES = {
  'HMT-1-burst-token': {
    updatedHoursAgo: 18,
    title: 'Burst allowance lets flood clients exceed the window limit',
    jiraKey: 'HMT-1',
    jiraStatus: 'In Progress',
    jiraPriority: 'Highest',
    jiraComments: 7,
    jiraAttachments: ['10021', '10022', '10023'],
    status: 'open',
    activeMode: 'review',
    phase: 'reviewing',
    // PHASE_INTENT: 'reviewing' — review findings (T.REVIEW_FINDINGS) are newer than the pull
    // request binding (T.PR_LINKED) and than every investigation signal.
    content: true
  },
  'HMT-9-quota-drift': {
    updatedHoursAgo: 330,
    title: 'Quota drift at fixed-window boundaries',
    jiraKey: 'HMT-9',
    jiraStatus: 'Done',
    jiraPriority: 'High',
    jiraComments: 12,
    jiraAttachments: ['10009'],
    status: 'closed',
    resolution: 'solved',
    activeMode: 'investigation',
    phase: 'closed',
    // PHASE_INTENT: 'closed' — status 'closed' short-circuits derivePhase entirely, so this
    // case's badge is stable no matter what is later ingested into it.
    content: true
  },
  'HMT-3-cancelled': {
    updatedHoursAgo: 6,
    title: 'Verify job cancelled by a concurrency group, read as a failure',
    jiraKey: 'HMT-3',
    jiraStatus: 'In Review',
    jiraPriority: 'Medium',
    jiraComments: 4,
    jiraAttachments: [],
    status: 'open',
    activeMode: 'investigation',
    phase: 'rca-drafted',
    // PHASE_INTENT: 'rca-drafted' — the phase pin at T.RCA_PIN is the newest signal. It has no
    // evidence tree precisely so a Rescan cannot outrank the pin and take the badge away.
    pin: 'rca-drafted',
    content: false
  },
  'HMT-4-nochecks': {
    updatedHoursAgo: 30,
    title: 'Public endpoint list matched by prefix',
    jiraKey: 'HMT-4',
    jiraStatus: 'In Progress',
    jiraPriority: 'Low',
    jiraComments: 2,
    jiraAttachments: [],
    status: 'open',
    activeMode: 'review',
    phase: 'pr-created',
    // PHASE_INTENT: 'pr-created' — the binding (stamped 12h later than T.PR_LINKED in
    // demo/prs.mjs) must be this case's newest signal, so BOTH its turns and its findings are
    // pushed back behind it. Without the findingHours override the review findings land at
    // T.REVIEW_FINDINGS and this case reads 'reviewing' like the flagship.
    findingHours: { review: 30 },
    content: false
  },
  'NAV-212-route-flicker': {
    updatedHoursAgo: 52,
    title: 'Route line flickers when re-routing mid-manoeuvre',
    jiraKey: 'NAV-212',
    jiraStatus: 'In Progress',
    jiraPriority: 'Lowest',
    jiraComments: 3,
    jiraAttachments: ['10044'],
    status: 'open',
    activeMode: 'investigation',
    phase: 'analyzing',
    // PHASE_INTENT: 'analyzing' — an investigation session and nothing newer.
    sessions: 'investigation',
    content: false
  },
  'NAV-118-stopover-drop': {
    updatedHoursAgo: 96,
    title:
      'CLONE - [NAV] Stopover reported as reached several hundred metres early and the remaining route is silently dropped',
    jiraKey: 'NAV-118',
    jiraStatus: 'Triage',
    jiraPriority: 'Escalated', // outside every mapped vocabulary → text-chip fallback
    jiraComments: 1,
    jiraAttachments: [],
    status: 'open',
    activeMode: 'investigation',
    phase: 'open',
    // PHASE_INTENT: 'open' — NO signals of any kind. No session, no finding, no evidence tree,
    // no binding. This is the only way derivePhase returns 'open', so this case must stay empty.
    sessions: 'none',
    findings: false,
    content: false
  },
  'ADAS-77-lane-bias': {
    updatedHoursAgo: 140,
    title: 'Lane centring biases right on crowned road surfaces',
    jiraKey: null,
    jiraStatus: null,
    jiraPriority: null, // no glyph and no chip
    jiraComments: null,
    jiraAttachments: [],
    status: 'open',
    activeMode: 'investigation',
    phase: 'analyzing',
    // PHASE_INTENT: 'analyzing'
    sessions: 'investigation',
    content: false
  },
  'NAV-305-tile-cache': {
    updatedHoursAgo: 400,
    title: 'Tile cache warm-up races the first route request on cold boot',
    jiraKey: 'NAV-305',
    jiraStatus: 'Done',
    jiraPriority: 'High',
    jiraComments: 9,
    jiraAttachments: [],
    status: 'closed',
    resolution: 'solved',
    activeMode: 'investigation',
    phase: 'closed',
    // PHASE_INTENT: 'closed'
    sessions: 'investigation',
    content: false
  }
}

export const CASE_CONFIG = CASES

/** Verbatim mirror of CASE_WORKING_RULES in src/main/services/caseService.ts. */
const CASE_WORKING_RULES = `## Working rules

- Cite evidence as \`[<rel-path>:<line>]\` for every claim based on evidence, e.g. \`[evidence/app.log:812]\`.
- Record findings with the \`mcp__argus__append_finding\` tool — never edit \`findings.md\` directly.
- Search evidence with \`mcp__argus__search_evidence\` before grepping files.
- To inspect a linked repo at a branch/PR/tag, call \`mcp__argus__workspace_checkout\` — never \`git switch\`/\`checkout\` in the primary checkout.
- Register derived files you create as evidence via \`mcp__argus__ingest_artifact\` so they become searchable and citable.
`

/** Mirror of scaffoldCaseLinks in caseService.ts — the case dir's .claude is the plugin root. */
function scaffoldCaseLinks(argusHome, dir) {
  const dotClaude = path.join(dir, '.claude')
  fs.mkdirSync(dotClaude, { recursive: true })
  for (const [name, target] of [
    ['skills', path.join(argusHome, 'skills')],
    ['references', path.join(argusHome, 'references')]
  ]) {
    const link = path.join(dotClaude, name)
    const linkType = process.platform === 'win32' ? 'junction' : 'dir'
    if (!fs.existsSync(link) && fs.existsSync(target)) fs.symlinkSync(target, link, linkType)
  }
}

/**
 * Tool calls, per session, in the order the transcript shows them.
 *
 * These are not decoration: `detail` is what the Library's `N× · last <date>` usage stats are
 * counted from (observability/usage.ts). `ref:<relpath>` rows count as reference reads, a
 * `Skill` row with decision 'observed' counts as a skill invocation, and read_memory's detail
 * names the topic. They are the only evidence in the product that the flywheel's output is
 * being reused, so they are kept in step with the transcript rather than invented.
 */
const FLAGSHIP_INVESTIGATION_TOOLS = [
  { tool: 'mcp__argus__search_evidence', risk: 'LOW', decision: 'auto', detail: null },
  { tool: 'Read', risk: 'LOW', decision: 'auto', detail: null },
  { tool: 'Read', risk: 'LOW', decision: 'auto', detail: null },
  { tool: 'mcp__argus__read_memory', risk: 'LOW', decision: 'auto', detail: 'burst-window-math' },
  { tool: 'Read', risk: 'LOW', decision: 'auto', detail: null },
  { tool: 'Read', risk: 'LOW', decision: 'grant', detail: 'ref:rate-limit-patterns.md' },
  { tool: 'Read', risk: 'LOW', decision: 'auto', detail: null },
  { tool: 'mcp__argus__append_finding', risk: 'LOW', decision: 'auto', detail: null },
  { tool: 'mcp__argus__append_finding', risk: 'LOW', decision: 'auto', detail: null }
]

const FLAGSHIP_REVIEW_TOOLS = [
  { tool: 'mcp__argus__workspace_checkout', risk: 'MEDIUM', decision: 'user', detail: null },
  { tool: 'Skill', risk: 'LOW', decision: 'observed', detail: 'code-review' },
  { tool: 'Read', risk: 'LOW', decision: 'auto', detail: null },
  { tool: 'Read', risk: 'LOW', decision: 'auto', detail: null },
  { tool: 'mcp__argus__append_finding', risk: 'LOW', decision: 'auto', detail: null },
  { tool: 'mcp__argus__append_finding', risk: 'LOW', decision: 'auto', detail: null },
  { tool: 'mcp__argus__append_finding', risk: 'LOW', decision: 'auto', detail: null },
  { tool: 'mcp__argus__append_finding', risk: 'LOW', decision: 'auto', detail: null },
  { tool: 'mcp__argus__push_finding_comment', risk: 'HIGH', decision: 'user', detail: null },
  { tool: 'mcp__argus__push_finding_comment', risk: 'HIGH', decision: 'user', detail: null }
]

/** The prior case is where `rate-limit-review` and the team reference were first used. */
const PRIOR_TOOLS = [
  { tool: 'Skill', risk: 'LOW', decision: 'observed', detail: 'rate-limit-review' },
  { tool: 'Read', risk: 'LOW', decision: 'auto', detail: 'ref:rate-limit-patterns.md' },
  { tool: 'Read', risk: 'LOW', decision: 'auto', detail: 'ref:glossary.md' },
  { tool: 'mcp__argus__read_memory', risk: 'LOW', decision: 'auto', detail: 'burst-window-math' },
  { tool: 'Bash', risk: 'HIGH', decision: 'denied', detail: null },
  { tool: 'mcp__argus__append_finding', risk: 'LOW', decision: 'auto', detail: null }
]

const THIN_TOOLS = [
  { tool: 'Read', risk: 'LOW', decision: 'auto', detail: null },
  { tool: 'Skill', risk: 'LOW', decision: 'observed', detail: 'hive-log-triage' },
  { tool: 'Edit', risk: 'MEDIUM', decision: 'user', detail: null }
]

function sessionPlan(slug, cfg) {
  if (slug === 'HMT-1-burst-token') {
    return [
      {
        mode: 'investigation',
        driver: 'claude-agent-sdk',
        instance: 'claude-agent-sdk-1',
        model: 'claude-opus-5',
        title: 'Why is flood-7 served past its limit?',
        turns: 4,
        tools: FLAGSHIP_INVESTIGATION_TOOLS,
        baseHours: 48
      },
      {
        mode: 'review',
        driver: 'claude-agent-sdk',
        instance: 'claude-agent-sdk-1',
        model: 'claude-opus-5',
        title: 'Layered review — pull request #4',
        turns: 3,
        tools: FLAGSHIP_REVIEW_TOOLS,
        baseHours: 20
      }
    ]
  }
  if (cfg.sessions === 'none') return []
  if (slug === 'HMT-9-quota-drift') {
    return [
      {
        mode: 'investigation',
        driver: 'claude-agent-sdk',
        instance: 'claude-agent-sdk-1',
        model: 'claude-opus-5',
        title: 'Quota drift at the window boundary',
        turns: 3,
        tools: PRIOR_TOOLS,
        baseHours: 336
      }
    ]
  }
  const mode = cfg.sessions === 'investigation' ? 'investigation' : 'review'
  return [
    {
      mode,
      driver: mode === 'review' ? 'github-copilot' : 'claude-agent-sdk',
      instance: mode === 'review' ? 'github-copilot-1' : 'claude-agent-sdk-1',
      model: mode === 'review' ? 'auto' : 'claude-sonnet-5',
      title: mode === 'review' ? 'review run' : 'first pass',
      turns: 2,
      tools: THIN_TOOLS,
      baseHours: 48
    }
  ]
}

export function seedCases(ctx, { repos, anchors }) {
  const caseIds = {}
  const sessionIds = {}

  for (const slug of ctx.SLUGS) {
    const cfg = CASES[slug]
    const isRepoCase = ctx.REPO_SLUGS.includes(slug)

    // Mirror deleteCase(): clear FTS rows through their map tables BEFORE the cascade, since
    // neither the FTS virtual tables nor their map side tables carry a foreign key to cases.
    const prior = ctx.db.prepare('SELECT id FROM cases WHERE slug = ?').get(slug)
    if (prior) {
      const msgRows = ctx.db
        .prepare('SELECT fts_rowid FROM messages_fts_map WHERE case_id = ?')
        .all(prior.id)
      const delMsg = ctx.db.prepare('DELETE FROM messages_fts WHERE rowid = ?')
      for (const r of msgRows) delMsg.run(r.fts_rowid)
      ctx.db.prepare('DELETE FROM messages_fts_map WHERE case_id = ?').run(prior.id)
      const evRows = ctx.db
        .prepare(
          `SELECT fts_rowid FROM evidence_fts_map
           WHERE evidence_id IN (SELECT id FROM evidence WHERE case_id = ?)`
        )
        .all(prior.id)
      const delEv = ctx.db.prepare('DELETE FROM evidence_fts WHERE rowid = ?')
      for (const r of evRows) delEv.run(r.fts_rowid)
      ctx.db
        .prepare(
          `DELETE FROM evidence_fts_map
           WHERE evidence_id IN (SELECT id FROM evidence WHERE case_id = ?)`
        )
        .run(prior.id)
    }
    ctx.db.prepare('DELETE FROM cases WHERE slug = ?').run(slug)
    // Not reached by the cases cascade — case_slug is plain TEXT with no FK.
    ctx.db.prepare('DELETE FROM case_summaries WHERE case_slug = ?').run(slug)
    ctx.db.prepare('DELETE FROM case_summaries_fts WHERE case_slug = ?').run(slug)
    ctx.db.prepare('DELETE FROM distill_jobs WHERE case_slug = ?').run(slug)
    fs.rmSync(ctx.caseDir(slug), { recursive: true, force: true })
    fs.rmSync(path.join(ctx.argusHome, '.dev-prompts', slug), { recursive: true, force: true })

    const workspaces = isRepoCase
      ? [
          {
            path: repos.hmtDir.replace(/\\/g, '/'),
            remote: 'https://github.com/JiaweiHan88/HiveMindTest.git',
            branch: 'main'
          }
        ]
      : []

    const created = ctx.at(cfg.status === 'closed' ? ctx.T.PRIOR_WORK : ctx.T.CREATED)
    // Spread across days on purpose. `cases.updated_at` is explicitly NOT a phase signal —
    // derivePhase excludes it because bookkeeping bumps it as readily as work does — so these
    // ages are free to vary for how the dashboard reads without touching any badge. Without the
    // spread every card says "updated today", which is the single clearest tell that a
    // dashboard is a fixture rather than a workspace someone uses.
    const updated = ctx.at(cfg.updatedHoursAgo)

    ctx.db
      .prepare(
        `INSERT INTO cases
           (slug, title, jira_key, status, resolution, tags, workspaces, active_mode,
            jira_status, jira_priority, jira_comment_count, jira_attachment_ids,
            jira_synced_at, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, '[]', ?, ?, ?, ?, ?, ?, ?, ?, ?)`
      )
      .run(
        slug,
        cfg.title,
        cfg.jiraKey,
        cfg.status,
        cfg.resolution ?? null,
        JSON.stringify(workspaces),
        cfg.activeMode,
        cfg.jiraStatus,
        cfg.jiraPriority,
        cfg.jiraComments,
        JSON.stringify(cfg.jiraAttachments ?? []),
        cfg.jiraKey ? ctx.at(ctx.T.DISTILL) : null,
        created,
        updated
      )
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
    for (const plan of sessionPlan(slug, cfg)) {
      const sAt = ctx.at(plan.baseHours + 0.2)
      const r = insSession.run(
        caseId,
        plan.driver,
        plan.instance,
        plan.model,
        plan.title,
        plan.turns,
        sAt,
        ctx.at(plan.baseHours - 0.5),
        plan.mode
      )
      const sessionId = Number(r.lastInsertRowid)
      byMode[plan.mode] = sessionId

      const turnIds = []
      for (let i = 0; i < plan.turns; i++) {
        turnIds.push(
          Number(
            insTurn.run(
              caseId,
              sessionId,
              i,
              'success',
              18420 + i * 4200,
              520 + i * 260,
              0.083 + i * 0.031,
              14900 + i * 6200,
              plan.model,
              ctx.at(plan.baseHours - i * 0.2)
            ).lastInsertRowid
          )
        )
      }

      plan.tools.forEach((tc, k) => {
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
          ctx.at(plan.baseHours - (k % turnIds.length) * 0.2)
        )
      })

      // ── Transcript. The flagship gets the written narrative; everything else gets a short
      //    but well-formed stand-in, so no session anywhere replays as an empty pane. ──
      const events =
        slug === 'HMT-1-burst-token' && plan.mode === 'investigation'
          ? investigationEvents({
              caseId,
              caseSlug: slug,
              sessionId,
              turnIds,
              model: plan.model,
              anchors,
              at: ctx.at
            })
          : slug === 'HMT-1-burst-token' && plan.mode === 'review'
            ? reviewEvents({
                caseId,
                caseSlug: slug,
                sessionId,
                turnIds,
                model: plan.model,
                anchors,
                at: ctx.at
              })
            : thinEvents({ ctx, caseId, slug, sessionId, turnIds, plan })

      fs.writeFileSync(
        path.join(dir, 'sessions', `${sessionId}.jsonl`),
        `${events.map((e) => JSON.stringify(e)).join('\n')}\n`,
        'utf8'
      )

      // Chat-search rows, from the same events, so search finds what the pane shows.
      for (const e of events) {
        const text =
          e.type === 'turn.started'
            ? e.payload.userText
            : e.type === 'assistant.message'
              ? e.payload.text
              : null
        if (!text) continue
        const res = insFts.run(
          text,
          caseId,
          sessionId,
          e.turnId,
          e.type === 'turn.started' ? 'user' : 'assistant'
        )
        insFtsMap.run(Number(res.lastInsertRowid), caseId, sessionId)
      }
    }

    // Thin cases have no investigation session; point both keys at whatever exists so findings
    // never get a null session_id. Null when the case has no session at all (NAV-118).
    sessionIds[slug] = {
      investigation: byMode.investigation ?? byMode.review ?? null,
      review: byMode.review ?? byMode.investigation ?? null
    }

    writeCaseJson(ctx, slug, cfg, { workspaces, created, updated })
    writeCaseClaudeMd(ctx, slug, cfg, { workspaces, created, worktree: repos.worktrees[slug] })
  }

  return { caseIds, sessionIds }
}

/** A short, well-formed transcript for the cases that are not the flagship. */
function thinEvents({ ctx, caseId, slug, sessionId, turnIds, plan }) {
  const events = []
  let n = 0
  const ev = (type, payload, turnId, ts) =>
    events.push({
      eventId: `demo-s${sessionId}-${String(++n).padStart(3, '0')}`,
      caseId,
      caseSlug: slug,
      sessionId,
      turnId,
      ts,
      type,
      payload
    })
  const h = plan.baseHours
  ev('session.started', { model: plan.model, resumed: false }, null, ctx.at(h + 0.2))
  const lines =
    plan.mode === 'review'
      ? [
          [
            'Review the diff on this branch and record what you find.',
            'Two findings recorded: a duplicated retry constant and a missing negative test for the changed branch. Neither blocks the merge on its own.'
          ],
          [
            'Anything on the test side?',
            'The changed branch has no negative case at all. The existing suite only asserts the happy path, so a regression here would ship green.'
          ]
        ]
      : [
          [
            `Start on ${slug} — what does the evidence say?`,
            'Working through the attached logs now. The first thing that stands out is a cluster of warnings in the same second as the state transition, which is usually where this class of defect shows itself.'
          ],
          [
            'Narrow it to the transition.',
            'The transition itself is clean. What is not clean is the retry immediately after it — that path re-enters before the previous attempt has released, which matches the reported symptom.'
          ]
        ]
  lines.forEach(([user, assistant], i) => {
    const turnId = turnIds[Math.min(i, turnIds.length - 1)]
    const t = ctx.at(h - i * 0.2)
    ev('turn.started', { userText: user }, turnId, t)
    ev(
      'assistant.message',
      { text: assistant },
      turnId,
      new Date(Date.parse(t) + 4000).toISOString()
    )
    ev(
      'turn.completed',
      {
        status: 'success',
        inputTokens: 9200 + i * 1400,
        outputTokens: 310 + i * 90,
        costUsd: 0.041,
        durationMs: 9800
      },
      turnId,
      new Date(Date.parse(t) + 9000).toISOString()
    )
  })
  return events
}

/** Mirror of the record the app writes to case.json on every case update. */
function writeCaseJson(ctx, slug, cfg, { workspaces, created, updated }) {
  const doc = {
    slug,
    title: cfg.title,
    jiraKey: cfg.jiraKey,
    jiraSyncedAt: cfg.jiraKey ? ctx.at(ctx.T.DISTILL) : null,
    jiraDeselected: [],
    jiraStatus: cfg.jiraStatus,
    jiraPriority: cfg.jiraPriority,
    jiraCommentCount: cfg.jiraComments,
    jiraAttachmentIds: cfg.jiraAttachments ?? [],
    reviewBaseline: null,
    lastSyncError: null,
    status: cfg.status,
    resolution: cfg.resolution ?? null,
    activeMode: cfg.activeMode,
    tags: [],
    createdAt: created,
    updatedAt: updated,
    actionItems: [],
    workspaces
  }
  fs.writeFileSync(
    path.join(ctx.caseDir(slug), 'case.json'),
    `${JSON.stringify(doc, null, 2)}\n`,
    'utf8'
  )
}

function writeCaseClaudeMd(ctx, slug, cfg, { workspaces, created, worktree }) {
  const pr = ctx.PR_NUMBERS[slug]
  const wsBlock = workspaces.length
    ? workspaces.map((w) => `- \`${w.path}\` (linked at branch \`${w.branch}\`)`).join('\n')
    : '_(no linked workspace)_'
  const prBlock = pr
    ? `- \`JiaweiHan88/HiveMindTest#${pr}\` (https://github.com/JiaweiHan88/HiveMindTest/pull/${pr})` +
      (worktree ? ` — checked out at \`${worktree.dir}\`` : '')
    : '_(no linked pull request)_'
  const md = `# Case: ${slug}

- Title: ${cfg.title}
- Jira: ${cfg.jiraKey ?? '(none)'}
- Opened: ${created}
- This directory is the case dir. Evidence lives in \`evidence/\`.

## Linked code workspaces

<!-- argus:workspaces -->
${wsBlock}
<!-- /argus:workspaces -->

## Linked pull requests

<!-- argus:prs -->
${prBlock}
<!-- /argus:prs -->

${CASE_WORKING_RULES}`
  fs.writeFileSync(path.join(ctx.caseDir(slug), 'CLAUDE.md'), md, 'utf8')
}

/**
 * Mirror of pinCasePhase() in caseService.ts. A pin is NOT sticky — it competes on
 * `phase_pinned_at` like every other signal — so this runs last, after the pull-request
 * bindings it would otherwise lose to.
 */
export function pinCasePhase(ctx, { slug, pin, hoursAgo }) {
  const at = ctx.at(hoursAgo)
  ctx.db
    .prepare(`UPDATE cases SET phase_pin = ?, phase_pinned_at = ?, updated_at = ? WHERE slug = ?`)
    .run(pin, at, at, slug)
  const file = path.join(ctx.caseDir(slug), 'case.json')
  const onDisk = JSON.parse(fs.readFileSync(file, 'utf8'))
  fs.writeFileSync(
    file,
    `${JSON.stringify({ ...onDisk, phasePin: pin, phasePinnedAt: at, updatedAt: at }, null, 2)}\n`,
    'utf8'
  )
}
