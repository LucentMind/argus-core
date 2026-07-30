import fs from 'node:fs'
import path from 'node:path'

const HIVE_PINS = {
  skills: {
    'hive-log-triage': '1057187557996e3c741fbf0a019716305b3ae48e',
    'hive-regression-bisect': '54e0e6b3d04ec6fc38561a98a4b14424310ff17e'
  },
  references: {
    'hive-known-issues.md': '1057187557996e3c741fbf0a019716305b3ae48e',
    // This pin key deliberately keeps the 'confluence/' prefix even though the
    // installed file itself lives flat at references/hive-adasis-profile.md.
    // The key names the upstream HiveMind repo path (references/confluence/x.md
    // in the source tree); the value in state tracks what commit was installed
    // from there. hivemind.ts's install() flattens confluence/x.md → x.md on
    // disk, and its installed-state probe checks that flat basename — so the
    // pin key and the on-disk path are two different things that happen to
    // share a stem. See the refs entry below for the on-disk side.
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
      // distill_jobs.id is an autoincrement INTEGER; a later task seeds ids 1-4
      // (1, 2 done; 3 failed; 4 queued). Stamped '2' so buildEvalBundle's
      // fmField(fm, 'job') === String(row.id) match can actually succeed.
      jobId: '2',
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
      // Job-linked so evalExport's scanJobStamped() can find it: distill_jobs
      // row 1 (seeded by a later task) needs a non-empty archived bundle.
      jobId: '1',
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
      // Job-linked to row 2. Job 1 emits all five reject tags plus one accepted
      // item (timezone-note, req-1042-note/overfit, token-compare-note/wrong,
      // burst-window-math-2/duplicate, write-good-code/overgeneric, ci-note/other).
      // Job 2 is skipped: a pending proposal carries its stamp (code-review,
      // line 58). Job 3 yields an empty item list (failed state). Job 4 is
      // unfinished (queued state). The three skipped jobs exercise the export
      // harness against each skip reason.
      jobId: '2',
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
      // Job-linked to row 1, alongside the accepted timezone-note above, so
      // job 1's archived bundle carries both outcome labels.
      jobId: '1',
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
      // Job-linked to row 1, so it emits to the export bundle alongside other
      // rejected items (token-compare-note, burst-window-math-2) and accepted
      // items (timezone-note) from that job.
      jobId: '1',
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
      jobId: '1',
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
      jobId: '1',
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
      // Job-linked to row 1, so it emits to the export bundle. This is the
      // final reject tag needed to cover all five tag values in the corpus.
      jobId: '1',
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
export function writeProposalFile(dir, p) {
  // listProposals() sorts on this field (string compare), and the real
  // writer derives the filename's date prefix from this same timestamp
  // (proposals.ts's writeProposal). Deriving it back from the filename here
  // (rather than stamping every proposal with the seed's wall-clock "now")
  // keeps the two in agreement, so the intended pending/archived chronology
  // isn't an unstable tie.
  const date = `${p.file.slice(0, 10)}T00:00:00.000Z`
  const fm = {
    type: p.type,
    target: p.target,
    case: p.caseSlug,
    date,
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

/**
 * Writes `name` into `cfgDir`, first snapshotting whatever was already there
 * into `cfgDir/.seed-backup/name` — but ONLY the first time this name is ever
 * replaced. First-generation-wins, not "latest overwritten one": on a re-seed,
 * the file already on disk is the seed's own previous literal, not the user's
 * real config, so backing that up instead would silently replace the one copy
 * of the user's original file with a copy of the seed's own output — precisely
 * the bug this scheme exists to avoid. Once a backup for a name exists, it is
 * never touched again by a later run. See seedKnowledge's config/ comment for
 * why config/ can't just be added to guardHome()'s CONTENT_DIRS instead.
 */
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
      writeProposalFile(pDir, p)
      pending++
    } else {
      writeProposalFile(aDir, p)
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
  fs.rmSync(refDir, { recursive: true, force: true })
  fs.mkdirSync(refDir, { recursive: true })
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
      // Written flat, NOT under references/confluence/ — HiveMind installs
      // flatten (hivemind.ts's install(): 'confluence/x.md' in the source repo
      // lands at 'references/x.md' locally), and listItems()'s installed-state
      // probe checks that flat basename. A confirmed live home has
      // references/hive-adasis-profile.md at the top level with no confluence/
      // subdirectory at all, while the pin in hivemind-state.json still reads
      // 'confluence/hive-adasis-profile.md' (see HIVE_PINS.references above).
      // Writing this file under references/confluence/ would make Browse show
      // it as "not installed" despite a pin existing — a state no real install
      // can produce — and would hide it from the flat references/ reads that
      // the distill references index and reference search both do.
      file: 'hive-adasis-profile.md',
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

  // guardHome() (seed-test-home.mjs) cannot treat config/ as guarded content: a freshly
  // booted home always has an empty references/proposals/etc. but a fully-configured
  // config/ (provider instances, hivemind repo, tool-risk overrides), so adding config/
  // to CONTENT_DIRS would make every legitimate first seed of a scratch home demand
  // --force — training the user to pass --force reflexively and dissolving the guard's
  // second tier for everyone. Instead, make the overwrite recoverable via writeConfigFile
  // (defined above the top of this function), which snapshots whatever was there
  // immediately BEFORE THE FIRST TIME each of the four files below is replaced.

  writeConfigFile(
    cfgDir,
    'hivemind-state.json',
    `${JSON.stringify({ lastSynced: now, skills: HIVE_PINS.skills, references: HIVE_PINS.references, pushes: {} }, null, 2)}\n`
  )

  // ── Memory. One array is the source of truth for the topic files, the
  // _index.md link lines, and the .audit.jsonl records, so the three can't
  // drift out of sync with each other the way three separately-typed literals
  // would. ──
  const memDir = path.join(home, 'memory')
  fs.rmSync(memDir, { recursive: true, force: true })
  fs.mkdirSync(memDir, { recursive: true })
  const memories = [
    {
      topic: 'burst-window-math',
      caseSlug: 'HMT-1-burst-token',
      summary: 'window-position check on burst allowances',
      body: '# burst-window-math\n\nA burst granted without a window-position check raises the effective cap.\n'
    },
    {
      topic: 'timezone-note',
      caseSlug: 'HMT-1-burst-token',
      summary: 'tile-service logs are local time',
      body: '# timezone-note\n\nTile-service logs are local time.\n'
    },
    {
      topic: 'cold-boot-timeout',
      caseSlug: 'HMT-1-burst-token',
      summary: 'empty tile cache only',
      body: '# cold-boot-timeout\n\nReproduces only with an empty tile cache.\n'
    }
  ]
  for (const m of memories) fs.writeFileSync(path.join(memDir, `${m.topic}.md`), m.body, 'utf8')
  // Real index lines are markdown links — memory.ts's indexLineFor/filteredIndex
  // both match `(<topic>.md)`, not a bare topic name.
  fs.writeFileSync(
    path.join(memDir, '_index.md'),
    `# Memory index\n\n${memories.map((m) => `- [${m.topic}](${m.topic}.md) — ${m.summary}`).join('\n')}\n`,
    'utf8'
  )
  // Matches MemoryAuditEntry (memory.ts / shared/memoryIpc.ts): { ts, caseSlug,
  // topic, indexEntry, bytes, action? }. `action` is omitted — absent means an
  // agent write, which is what these are. `bytes` is measured off the actual
  // body written above rather than hand-typed, so it can't drift from the file.
  fs.writeFileSync(
    path.join(memDir, '.audit.jsonl'),
    `${memories
      .map((m) =>
        JSON.stringify({
          ts: now,
          caseSlug: m.caseSlug,
          topic: m.topic,
          indexEntry: m.summary,
          bytes: Buffer.byteLength(m.body, 'utf8')
        })
      )
      .join('\n')}\n`,
    'utf8'
  )

  // ── Config: several providers enabled at once, non-default access and risk. ──
  writeConfigFile(
    cfgDir,
    'settings.json',
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
    )}\n`
  )
  writeConfigFile(
    cfgDir,
    'agent-access.json',
    // Skill keys are tier-qualified ('<tier>/<name>' — skillsResolver.ts's
    // skillEnabled call); 'user/burst-window-review' names a skill this same
    // function creates above, so the override is visibly in effect.
    `${JSON.stringify({ skills: { 'user/burst-window-review': false }, memory: { 'timezone-note': false } }, null, 2)}\n`
  )
  writeConfigFile(
    cfgDir,
    'tool-risk.json',
    // Keys are '<connectorInstanceId>/<toolName>' (toolRisk.ts) and are
    // consulted ONLY for mcp__<server>__<tool> connector calls (agent/risk.ts's
    // classifyToolCall matches `mcp__(.+?)__(.+)` and looks up
    // `${server}/${tool}`) — bare native tools like Bash/Edit resolve through
    // the driver's own taxonomy and never touch this file, so keying entries
    // on them (as before) makes the file schema-valid but functionally inert.
    // 'rovo' is a plausible Atlassian/Jira connector instance id (same
    // convention as toolRisk.test.ts); 'getJiraIssue' would otherwise
    // name-convention-classify 'low' (classifyToolName: leading 'get' → low),
    // so overriding it to 'high' actually changes the verdict instead of
    // silently reinforcing the default.
    //
    // toolRisk.ts validates values against RISK_LEVELS = ['low','medium','high']
    // (lowercase) and silently degrades the whole file to {} on a schema
    // mismatch — so the levels here must stay lowercase to load at all.
    //
    // Do NOT "harmonise" this with tool_calls.risk in the database, which is
    // uppercase LOW/MEDIUM/HIGH: that's a different axis (the logged verdict
    // for a specific call) that happens to share three level names with this
    // config's override levels — they are read by unrelated code paths.
    `${JSON.stringify({ 'rovo/getJiraIssue': 'high' }, null, 2)}\n`
  )

  return {
    proposals: pending,
    archived,
    userSkills: userSkills.length,
    hiveSkills,
    references: refs.length
  }
}
