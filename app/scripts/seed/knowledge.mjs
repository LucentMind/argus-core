import fs from 'node:fs'
import path from 'node:path'

const HIVE_PINS = {
  skills: {
    'hive-log-triage': '1057187557996e3c741fbf0a019716305b3ae48e',
    'hive-regression-bisect': '54e0e6b3d04ec6fc38561a98a4b14424310ff17e'
  },
  references: {
    'hive-known-issues.md': '1057187557996e3c741fbf0a019716305b3ae48e',
    'confluence/hive-adasis-profile.md': '113d0546fe6013f80df841dc636ec95852b6d72d'
  }
}

/**
 * Pending proposals cover every type; archived ones cover every reject reason
 * plus the accepted label. The archive is the corpus the distill feedback
 * loop's NDJSON export reads, so both labels must be present.
 */
export function buildProposals() {
  return [
    {
      file: '2026-07-30-HMT-1-burst-token-window-boundary-math.md',
      type: 'skill-new',
      target: 'window-boundary-math',
      caseSlug: 'HMT-1-burst-token',
      title: 'Reason about rate-limit window boundaries',
      content:
        '---\nname: window-boundary-math\ndescription: Use when reviewing rate limiters or quota code.\n---\n\nAlways ask when the limit was reached, not just whether it was.\n',
      status: 'pending',
      rejectTag: null,
      rejectNote: null,
      jobId: null,
      previouslyReviewed: false
    },
    {
      file: '2026-07-30-HMT-1-burst-token-code-review.md',
      type: 'skill-edit',
      target: 'code-review',
      caseSlug: 'HMT-1-burst-token',
      title: 'Add a constant-time comparison check to code review',
      content:
        '---\nname: code-review\ndescription: Review a diff for correctness, security, tests and conformance.\n---\n\nWhen the diff compares a secret, check the comparison is constant time.\n',
      status: 'pending',
      rejectTag: null,
      rejectNote: null,
      jobId: 'job-2',
      previouslyReviewed: false
    },
    {
      file: '2026-07-30-HMT-1-burst-token-hive-known-issues.md',
      type: 'reference-edit',
      target: 'hive-known-issues.md',
      caseSlug: 'HMT-1-burst-token',
      title: 'Record the cold-boot timeout signature',
      content: '## Cold-boot timeout\n\nReproduces only with an empty tile cache.\n',
      status: 'pending',
      rejectTag: null,
      rejectNote: null,
      jobId: null,
      previouslyReviewed: true
    },
    {
      file: '2026-07-30-HMT-3-cancelled-ci-triage-recipe.md',
      type: 'recipe',
      target: 'ci-triage-recipe.md',
      caseSlug: 'HMT-3-cancelled',
      title: 'Triage a cancelled check',
      content:
        '1. Confirm the run was cancelled, not failed.\n2. Look for a concurrency group in the workflow.\n3. Re-run before reading the log — a cancellation log says nothing.\n',
      status: 'pending',
      rejectTag: null,
      rejectNote: null,
      jobId: null,
      previouslyReviewed: false
    },
    {
      file: '2026-07-30-HMT-1-burst-token-burst-window-math.md',
      type: 'memory-append',
      target: 'burst-window-math',
      caseSlug: 'HMT-1-burst-token',
      title: 'Burst allowances need a window-position check',
      content:
        'A burst granted without checking when the limit was hit raises the effective cap to limit + burst for the worst clients.\n',
      status: 'pending',
      rejectTag: null,
      rejectNote: null,
      jobId: null,
      previouslyReviewed: false
    },
    {
      file: '2026-07-30-HMT-4-nochecks-HMT-4-nochecks.md',
      type: 'case-summary',
      target: 'HMT-4-nochecks',
      caseSlug: 'HMT-4-nochecks',
      title: 'Public endpoints skipped auth by prefix match',
      content: 'Prefix matching on the public-endpoint list let /public-admin through.\n',
      status: 'pending',
      rejectTag: null,
      rejectNote: null,
      jobId: null,
      previouslyReviewed: false,
      // acceptProposal throws without these two, so a case-summary proposal that
      // lacks them is a fixture the user cannot actually accept. summary_json must
      // be single-line: writeProposal rejects multi-line extra frontmatter values.
      summaryJson: JSON.stringify({
        signature: 'auth bypass via prefix match on public endpoint list',
        symptoms: 'Requests to /public-admin reached admin handlers without a token.',
        rootCause: 'The public-endpoint allowlist was matched by prefix rather than exact path.',
        fix: 'Match the path exactly, and add a negative test for /public-admin.',
        keywords: ['auth', 'bypass', 'prefix', 'allowlist']
      }),
      resolution: 'solved'
    },
    // Archived — the labelled corpus.
    {
      file: '2026-07-29-HMT-1-burst-token-timezone-note.md',
      type: 'memory-append',
      target: 'timezone-note',
      caseSlug: 'HMT-1-burst-token',
      title: 'Log timestamps are local time',
      content: 'The tile service logs local time; a 2h gap is usually a timezone artifact.\n',
      status: 'accepted',
      rejectTag: null,
      rejectNote: null,
      // Not job-linked: buildEvalBundle/listProposals key job-linkage off a `job`
      // stamp, and this task carries exactly one such item (the pending skill-edit
      // above) — see task-7-report.md for why job-1 was dropped from here.
      jobId: null,
      previouslyReviewed: false
    },
    {
      file: '2026-07-29-HMT-1-burst-token-glossary.md',
      type: 'reference-edit',
      target: 'glossary.md',
      caseSlug: 'HMT-1-burst-token',
      title: 'Define burst allowance',
      content: '**Burst allowance** — extra requests granted beyond the window limit.\n',
      status: 'accepted',
      rejectTag: null,
      rejectNote: null,
      jobId: null,
      previouslyReviewed: false
    },
    {
      file: '2026-07-29-HMT-1-burst-token-req-1042-note.md',
      type: 'memory-append',
      target: 'req-1042-note',
      caseSlug: 'HMT-1-burst-token',
      title: 'Request 1042 returned 200',
      content: 'Request 1042 in app.log returned 200 rather than 429.\n',
      status: 'rejected',
      rejectTag: 'overfit',
      rejectNote: null,
      jobId: null,
      previouslyReviewed: false
    },
    {
      file: '2026-07-29-HMT-1-burst-token-write-good-code.md',
      type: 'skill-new',
      target: 'write-good-code',
      caseSlug: 'HMT-1-burst-token',
      title: 'Write good code',
      content:
        '---\nname: write-good-code\ndescription: Always write good code.\n---\n\nBe careful.\n',
      status: 'rejected',
      rejectTag: 'overgeneric',
      rejectNote: null,
      jobId: null,
      previouslyReviewed: false
    },
    {
      file: '2026-07-29-HMT-1-burst-token-token-compare-note.md',
      type: 'memory-append',
      target: 'token-compare-note',
      caseSlug: 'HMT-1-burst-token',
      title: 'String equality is constant time in Node',
      content: 'Node string equality is constant time, so the token compare is fine.\n',
      status: 'rejected',
      rejectTag: 'wrong',
      rejectNote: 'Node string comparison short-circuits on the first differing byte.',
      jobId: null,
      previouslyReviewed: false
    },
    {
      file: '2026-07-29-HMT-1-burst-token-burst-window-math-2.md',
      type: 'memory-append',
      target: 'burst-window-math',
      caseSlug: 'HMT-1-burst-token',
      title: 'Burst allowances need a window-position check',
      content: 'Same lesson as the pending burst-window-math proposal.\n',
      status: 'rejected',
      rejectTag: 'duplicate',
      rejectNote: null,
      jobId: null,
      previouslyReviewed: false
    },
    {
      file: '2026-07-29-HMT-2-green-ci-note.md',
      type: 'memory-append',
      target: 'ci-note',
      caseSlug: 'HMT-2-green',
      title: 'CI was green',
      content: 'All checks passed on this pull request.\n',
      status: 'rejected',
      rejectTag: 'other',
      rejectNote: null,
      jobId: null,
      previouslyReviewed: false
    }
  ]
}

function frontmatter(entries) {
  return ['---', ...Object.entries(entries).map(([k, v]) => `${k}: ${v}`), '---', ''].join('\n')
}

/**
 * Frontmatter key names here are chosen to match the real readers, NOT the
 * builder's JS field names:
 *  - job linkage: proposals.ts's listProposals() and evalExport.ts's
 *    scanJobStamped() both read `fmField(fm, 'job')` — not `job_id`.
 *  - reject reason: evalExport.ts reads `fmField(fm, 'reject_reason')` (the
 *    same key rejectProposal() itself writes) — not `reject_tag`.
 * Getting either wrong wouldn't fail any test here (buildProposals() is pure
 * JS), but it would silently break the on-disk corpus these tools read.
 */
function writeProposalFile(dir, p, now) {
  const fm = {
    type: p.type,
    target: p.target,
    case: p.caseSlug,
    date: now,
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

export function seedKnowledge(ctx, { repos }) {
  const now = ctx.nowIso()
  const home = ctx.argusHome

  // ── Proposals: pending in proposals/, decided in proposals/archive/ ──
  const pDir = path.join(home, 'proposals')
  const aDir = path.join(pDir, 'archive')
  fs.rmSync(pDir, { recursive: true, force: true })
  fs.mkdirSync(aDir, { recursive: true })
  const proposals = buildProposals()
  let pending = 0
  let archived = 0
  for (const p of proposals) {
    if (p.status === 'pending') {
      writeProposalFile(pDir, p, now)
      pending++
    } else {
      writeProposalFile(aDir, p, now)
      archived++
    }
  }

  // ── Skills. Resolution precedence is user > hivemind > bundled and comes from
  // the DIRECTORY, not frontmatter (see agent/skillsResolver.ts). Two of the
  // three user skills deliberately collide so `shadows` is non-empty. ──
  const userDir = path.join(home, 'skills-user')
  const hiveDir = path.join(home, 'skills-hivemind')
  fs.rmSync(userDir, { recursive: true, force: true })
  fs.rmSync(hiveDir, { recursive: true, force: true })

  let hiveSkills = 0
  for (const name of Object.keys(HIVE_PINS.skills)) {
    const src = path.join(repos.hmtDir, 'skills', name)
    const dest = path.join(hiveDir, name)
    fs.mkdirSync(dest, { recursive: true })
    fs.copyFileSync(path.join(src, 'SKILL.md'), path.join(dest, 'SKILL.md'))
    hiveSkills++
  }

  const userSkills = [
    {
      name: 'code-review', // collides with a bundled skill
      body: '---\nname: code-review\ndescription: My own review checklist, overriding the bundled one.\n---\n\nCheck constant-time comparisons first.\n'
    },
    {
      name: 'hive-log-triage', // collides with a hivemind skill
      body: '---\nname: hive-log-triage\ndescription: Local edit of the hive log-triage skill.\n---\n\nStart from the last ERROR line, not the first.\n'
    },
    {
      name: 'burst-window-review',
      body: '---\nname: burst-window-review\ndescription: Use when reviewing rate limiters.\nroles: [review]\n---\n\nAsk when the limit was hit.\n'
    }
  ]
  for (const s of userSkills) {
    const dest = path.join(userDir, s.name)
    fs.mkdirSync(dest, { recursive: true })
    fs.writeFileSync(path.join(dest, 'SKILL.md'), s.body, 'utf8')
  }

  // ── References across all five trust tiers. `bundled` carries no frontmatter;
  // the rest declare trust_tier, and confluence adds the sources block (keys
  // page_id/last_synced — refFrontmatter.ts's parseRefSources only recognizes
  // those snake_case names, not pageId/lastSynced). ──
  const refDir = path.join(home, 'references')
  fs.mkdirSync(path.join(refDir, 'confluence'), { recursive: true })
  const refs = [
    { file: 'tile-endpoints.md', body: '# Tile endpoints\n\nBundled reference, no frontmatter.\n' },
    {
      file: 'glossary.md',
      body:
        frontmatter({ trust_tier: 'user', title: 'Glossary' }) +
        '**Burst allowance** — extra requests beyond the window limit.\n'
    },
    {
      file: 'ci-triage-recipe.md',
      body:
        frontmatter({ trust_tier: 'team-knowledge', title: 'CI triage recipe' }) +
        'Confirm cancelled before reading a log.\n'
    },
    {
      file: 'hive-known-issues.md',
      body:
        frontmatter({ trust_tier: 'hivemind', title: 'Known issues' }) +
        'Cold-boot timeout with an empty tile cache.\n'
    },
    {
      file: 'confluence/hive-adasis-profile.md',
      body:
        '---\ntrust_tier: confluence\ntitle: ADASIS profile\nsources:\n  - url: https://example.atlassian.net/wiki/spaces/NAV/pages/12345\n    page_id: "12345"\n    version: 7\n    last_synced: ' +
        now +
        '\n---\n\nSynced from Confluence.\n'
    }
  ]
  for (const r of refs) fs.writeFileSync(path.join(refDir, r.file), r.body, 'utf8')

  // ── HiveMind state: real commit shas, so Sync and Claim work live. ──
  const cfgDir = path.join(home, 'config')
  fs.mkdirSync(cfgDir, { recursive: true })
  fs.writeFileSync(
    path.join(cfgDir, 'hivemind-state.json'),
    `${JSON.stringify({ lastSynced: now, skills: HIVE_PINS.skills, references: HIVE_PINS.references, pushes: {} }, null, 2)}\n`,
    'utf8'
  )

  // ── Memory ──
  const memDir = path.join(home, 'memory')
  fs.mkdirSync(memDir, { recursive: true })
  const memories = {
    'burst-window-math.md':
      '# burst-window-math\n\nA burst granted without a window-position check raises the effective cap.\n',
    'timezone-note.md': '# timezone-note\n\nTile-service logs are local time.\n',
    'cold-boot-timeout.md': '# cold-boot-timeout\n\nReproduces only with an empty tile cache.\n'
  }
  for (const [f, body] of Object.entries(memories))
    fs.writeFileSync(path.join(memDir, f), body, 'utf8')
  fs.writeFileSync(
    path.join(memDir, '_index.md'),
    '# Memory index\n\n- burst-window-math — window-position check on burst allowances\n- timezone-note — tile-service logs are local time\n- cold-boot-timeout — empty tile cache only\n',
    'utf8'
  )
  fs.writeFileSync(
    path.join(memDir, '.audit.jsonl'),
    `${JSON.stringify({ ts: now, action: 'write', topic: 'burst-window-math', source: 'seed' })}\n`,
    'utf8'
  )

  // ── Config: several providers enabled at once, non-default access and risk. ──
  fs.writeFileSync(
    path.join(cfgDir, 'settings.json'),
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
              hiddenModels: ['claude-haiku-4-5'],
              favoriteModels: ['claude-opus-5'],
              modelOrder: []
            }
          }
        },
        hivemind: { repo: 'https://github.com/JiaweiHan88/HiveMindTest' },
        onboarding: { completedAt: now, phase1Done: true, tourDone: true },
        memoryHygiene: { trackingStartedAt: now }
      },
      null,
      2
    )}\n`,
    'utf8'
  )
  fs.writeFileSync(
    path.join(cfgDir, 'agent-access.json'),
    // Skill keys are tier-qualified ('<tier>/<name>' — skillsResolver.ts's
    // skillEnabled call); 'user/burst-window-review' names a skill this same
    // function creates above, so the override is visibly in effect.
    `${JSON.stringify({ skills: { 'user/burst-window-review': false }, memory: { 'timezone-note': false } }, null, 2)}\n`,
    'utf8'
  )
  fs.writeFileSync(
    path.join(cfgDir, 'tool-risk.json'),
    // toolRisk.ts validates values against RISK_LEVELS = ['low','medium','high']
    // (lowercase) and silently degrades the whole file to {} on a schema
    // mismatch — so the levels here must be lowercase to actually load.
    `${JSON.stringify({ Bash: 'high', Edit: 'medium' }, null, 2)}\n`,
    'utf8'
  )

  return {
    proposals: pending,
    archived,
    userSkills: userSkills.length,
    hiveSkills,
    references: refs.length
  }
}
