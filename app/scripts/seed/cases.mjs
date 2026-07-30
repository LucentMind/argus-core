import fs from 'node:fs'
import path from 'node:path'

const TITLES = {
  'HMT-1-burst-token': 'Burst allowance and legacy deploy-script tokens',
  'HMT-2-green': 'Green rollup fixture',
  'HMT-3-cancelled': 'Cancelled verify job on a red pull request',
  'HMT-4-nochecks': 'Public-endpoint auth skip (no CI configured)',
  'SYN-5-edge': 'Synthetic edge-case pull request'
}

const STATUSES = {
  'HMT-1-burst-token': 'analyzing',
  'HMT-2-green': 'open',
  'HMT-3-cancelled': 'analyzing',
  'HMT-4-nochecks': 'open',
  'SYN-5-edge': 'analyzing'
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
  {
    tool: 'mcp__argus__read_reference',
    risk: 'LOW',
    decision: 'grant',
    detail: 'hive-known-issues.md'
  },
  { tool: 'Edit', risk: 'MEDIUM', decision: 'user', detail: null }
]

export function seedCases(ctx, { repos }) {
  const now = ctx.nowIso()
  const caseIds = {}
  const sessionIds = {}

  for (const slug of ctx.SLUGS) {
    // Deleting the case cascades to sessions/turns/tool_calls/findings/bindings.
    ctx.db.prepare('DELETE FROM cases WHERE slug = ?').run(slug)
    fs.rmSync(ctx.caseDir(slug), { recursive: true, force: true })

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

    ctx.db
      .prepare(
        `INSERT INTO cases (slug, title, jira_key, status, tags, workspaces, active_mode, created_at, updated_at)
         VALUES (?, ?, 'HMT-1', ?, '[]', ?, 'review', ?, ?)`
      )
      .run(slug, TITLES[slug], STATUSES[slug], JSON.stringify(workspaces), now, now)
    const caseId = ctx.db.prepare('SELECT id FROM cases WHERE slug = ?').get(slug).id
    caseIds[slug] = caseId

    const dir = ctx.caseDir(slug)
    fs.mkdirSync(path.join(dir, 'sessions'), { recursive: true })
    fs.mkdirSync(path.join(dir, 'evidence'), { recursive: true })
    fs.mkdirSync(path.join(dir, 'artifacts'), { recursive: true })

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
    sessionIds[slug] = {
      investigation: byMode.investigation ?? byMode.review,
      review: byMode.review
    }

    writeCaseJson(ctx, slug, { caseId, workspaces, now })
    writeCaseClaudeMd(ctx, slug, { workspaces, now, worktree: repos.worktrees[slug] })
  }

  return { caseIds, sessionIds }
}

/** Mirror of the DB record the app writes on every case update. */
function writeCaseJson(ctx, slug, { workspaces, now }) {
  const doc = {
    slug,
    title: TITLES[slug],
    jiraKey: 'HMT-1',
    jiraSyncedAt: null,
    jiraDeselected: [],
    jiraStatus: null,
    jiraPriority: null,
    jiraCommentCount: null,
    jiraAttachmentIds: [],
    reviewBaseline: null,
    lastSyncError: null,
    status: STATUSES[slug],
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

function writeCaseClaudeMd(ctx, slug, { workspaces, now, worktree }) {
  const pr = ctx.PR_NUMBERS[slug]
  const md = `# Case: ${slug}

- Title: ${TITLES[slug]}
- Jira: HMT-1
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
`
  fs.writeFileSync(path.join(ctx.caseDir(slug), 'CLAUDE.md'), md, 'utf8')
}
