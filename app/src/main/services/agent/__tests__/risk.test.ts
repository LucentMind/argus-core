import path from 'node:path'
import { describe, it, expect } from 'vitest'
import {
  classifyToolCall,
  CLAUDE_TOOL_TAXONOMY,
  shellSegmentTokens,
  type RiskContext,
  type ToolTaxonomy
} from '../risk'
import type { SkillAssetContext } from '../../../../shared/agent-events'
import { sha256Hex } from '../../skillAssetReviews'

// Same command as the existing "cd outside sandbox → deny" case below
// ('classifyToolCall — Bash' → 'treats rm -rf as HIGH and cd outside sandbox as deny').
const OUT_OF_SANDBOX_CD = 'cd /home/u/other'

function ctx(overrides: Partial<RiskContext> = {}): RiskContext {
  return {
    caseDir: '/home/u/Argus/cases/NAV-1',
    workspaceRoots: ['/home/u/code/navigator', '/home/u/Argus/worktrees'],
    readonlyRoots: ['/home/u/Argus/skills', '/home/u/Argus/references'],
    taxonomy: CLAUDE_TOOL_TAXONOMY,
    ...overrides
  }
}

function bash(command: string): ReturnType<typeof classifyToolCall> {
  return classifyToolCall('Bash', { command }, ctx())
}

describe('classifyToolCall — native and FS tools', () => {
  it.each([
    ['mcp__argus__search_evidence', 'allow', 'LOW'],
    ['mcp__argus__search_known_defects', 'allow', 'LOW'],
    ['mcp__argus__append_finding', 'allow', 'LOW'],
    ['mcp__argus__update_case_status', 'ask', 'MEDIUM'],
    ['mcp__argus__workspace_checkout', 'ask', 'MEDIUM']
  ] as const)('%s → %s/%s', (tool, action, risk) => {
    const v = classifyToolCall(tool, {}, ctx())
    expect(v.action).toBe(action)
    expect(v.risk).toBe(risk)
  })

  it('read_memory is LOW auto-allow (enablement enforced in the handler)', () => {
    const v = classifyToolCall('mcp__argus__read_memory', { topic: 't' }, ctx())
    expect(v).toEqual({ action: 'allow', risk: 'LOW' })
  })

  it('write_proposal is LOW allow (inert until accepted)', () => {
    const v = classifyToolCall('mcp__argus__write_proposal', {}, ctx())
    expect(v).toEqual({ action: 'allow', risk: 'LOW' })
  })

  it('propose_case_triage is LOW allow (writes only to routine_run_items, inert until accepted)', () => {
    // Regression for the dead-feature defect: without a NATIVE_RISK entry this name falls to
    // CLAUDE_TOOL_TAXONOMY.fallback, which reads a name with neither a destructive verb nor a
    // read-ish prefix as write-capable and returns {action:'ask', risk:'MEDIUM'} — and an
    // unattended routine turn denies every ask (session.unattended.test.ts), so the one tool
    // the item loop exists to call would be denied on every single item, always.
    const v = classifyToolCall('mcp__argus__propose_case_triage', {}, ctx())
    expect(v).toEqual({ action: 'allow', risk: 'LOW' })
  })

  it('write_memory is MEDIUM ask with no session grant', () => {
    const v = classifyToolCall('mcp__argus__write_memory', { topic: 't', content: 'c' }, ctx())
    expect(v).toEqual({
      action: 'ask',
      risk: 'MEDIUM',
      grantKey: null,
      reason: "Replace an agent-memory topic's whole body (steers all future sessions)"
    })
  })

  it('allows Read inside the case dir, denies outside the sandbox', () => {
    expect(
      classifyToolCall('Read', { file_path: `${ctx().caseDir}/evidence/a.txt` }, ctx()).action
    ).toBe('allow')
    expect(classifyToolCall('Read', { file_path: '/home/u/.ssh/id_rsa' }, ctx()).action).toBe(
      'deny'
    )
  })

  it('denies Write into read-only roots, allows in case dir', () => {
    expect(
      classifyToolCall('Write', { file_path: '/home/u/Argus/skills/x/SKILL.md' }, ctx()).action
    ).toBe('deny')
    expect(
      classifyToolCall('Write', { file_path: `${ctx().caseDir}/notes.md` }, ctx()).action
    ).toBe('allow')
  })

  it('resolves relative and missing FS paths against caseDir instead of bypassing the sandbox', () => {
    // relative path traversal that escapes the sandbox entirely -> deny
    expect(classifyToolCall('Read', { file_path: '../../../../etc/passwd' }, ctx()).action).toBe(
      'deny'
    )
    // relative path that stays inside caseDir -> allow
    expect(classifyToolCall('Read', { file_path: 'evidence/a.txt' }, ctx()).action).toBe('allow')
    // relative path that escapes into a readonly root -> deny (write)
    const relIntoReadonly = path.relative(ctx().caseDir, `${ctx().readonlyRoots[0]}/x/SKILL.md`)
    expect(classifyToolCall('Write', { file_path: relIntoReadonly }, ctx()).action).toBe('deny')
    // missing path input -> treated as cwd (caseDir) -> allow
    expect(classifyToolCall('Glob', {}, ctx()).action).toBe('allow')
  })
})

describe('classifyToolCall — Bash', () => {
  it.each([
    ['git log --oneline -5', 'allow', 'LOW'],
    ['git blame src/router.cc', 'allow', 'LOW'],
    ['git -C /home/u/code/navigator diff HEAD~1', 'allow', 'LOW']
  ] as const)('%s → auto-allow', (cmd, action, risk) => {
    const v = bash(cmd)
    expect(v.action).toBe(action)
    expect(v.risk).toBe(risk)
  })

  it('allowlists pack-declared CLI names as LOW', () => {
    const v = classifyToolCall(
      'Bash',
      { command: 'tool-x decode evidence/trace.bin' },
      ctx({ packCliNames: ['tool-x'] })
    )
    expect(v).toEqual({ action: 'allow', risk: 'LOW' })
  })

  it('builtin classifiers win over a colliding pack CLI name (defense-in-depth)', () => {
    const v = classifyToolCall(
      'Bash',
      { command: 'git push origin main' },
      ctx({ packCliNames: ['git'] })
    )
    expect(v).toMatchObject({ action: 'ask', risk: 'HIGH' }) // classifyGit, not the allowlist
    const cd = classifyToolCall(
      'Bash',
      { command: 'cd /home/u/other' },
      ctx({ packCliNames: ['cd'] })
    )
    expect(cd.action).toBe('deny') // sandbox check, not the allowlist
  })

  it('does not allowlist undeclared programs', () => {
    const v = classifyToolCall(
      'Bash',
      { command: 'other-tool evidence/trace.bin' },
      ctx({ packCliNames: ['tool-x'] })
    )
    expect(v.action).toBe('allow') // generic default-LOW path, not the allowlist — see next test for the text-tool case
  })

  it('evidence nudge names the declared CLIs', () => {
    const v = classifyToolCall(
      'Bash',
      { command: 'grep foo evidence/trace.txt' },
      ctx({ packCliNames: ['tool-x', 'tool-y'] })
    )
    expect(v).toMatchObject({ action: 'ask', risk: 'MEDIUM' })
    expect((v as { reason: string }).reason).toContain('tool-x, tool-y')
  })

  it('evidence nudge still fires generically with no packs', () => {
    const v = classifyToolCall(
      'Bash',
      { command: 'cat evidence/huge.bin' },
      ctx({ packCliNames: [] })
    )
    expect(v).toMatchObject({ action: 'ask', risk: 'MEDIUM' })
  })

  it.each([
    'git fetch origin',
    'git switch feature/x',
    'git checkout v3.16.0',
    'gh pr checkout 1234'
  ])('%s → MEDIUM ask with workspace grant key', (cmd) => {
    const v = bash(cmd)
    expect(v).toMatchObject({ action: 'ask', risk: 'MEDIUM' })
    if (v.action === 'ask') expect(v.grantKey).toMatch(/^ws:/)
  })

  it.each([
    'git push origin main',
    'gh pr create --title x',
    'gh pr comment 12 --body hi',
    'gh pr merge 12',
    'gh api -X POST /repos/o/r/issues'
  ])('%s → HIGH ask, no grant key', (cmd) => {
    const v = bash(cmd)
    expect(v).toMatchObject({ action: 'ask', risk: 'HIGH' })
    if (v.action === 'ask') expect(v.grantKey).toBeNull()
  })

  // `search` is the GROUP token here, not the subcommand, so this is matched on the group
  // rather than by a GH_READ entry (which is tested against the sub).
  it.each([
    'gh search prs NN-5165 --repo acme/widget',
    'gh search issues NN-5165',
    'gh search code needle'
  ])('%s → read-only, auto-allowed', (cmd) => {
    expect(bash(cmd)).toEqual({ action: 'allow', risk: 'LOW' })
  })

  it('nudges raw grep/cat on evidence files to pack-declared CLIs (MEDIUM ask)', () => {
    for (const cmd of ['grep -c error evidence/applog.txt', 'cat evidence/applog.txt']) {
      const v = classifyToolCall('Bash', { command: cmd }, ctx({ packCliNames: ['tool-x'] }))
      expect(v).toMatchObject({ action: 'ask', risk: 'MEDIUM' })
      if (v.action === 'ask') expect(v.reason).toContain('tool-x')
    }
  })

  it('classifies the riskiest segment of a compound command', () => {
    const v = bash('git fetch origin && git log --oneline')
    expect(v).toMatchObject({ action: 'ask', risk: 'MEDIUM' })
  })

  it('treats rm -rf as HIGH and cd outside sandbox as deny', () => {
    expect(bash('rm -rf build')).toMatchObject({ action: 'ask', risk: 'HIGH' })
    expect(bash('cd /home/u/other && ls').action).toBe('deny')
  })

  it.each(['rm -R build', 'rm -Rf build', 'rm -fR build', 'rm --recursive build'])(
    '%s → recursive delete classified as HIGH ask',
    (cmd) => {
      expect(bash(cmd)).toMatchObject({ action: 'ask', risk: 'HIGH' })
    }
  )

  /**
   * A NEWLINE is a statement separator in every shell, exactly as `&&` and `;` are, and the Bash
   * tool takes ONE command string — so a model writing two lines used to produce ONE segment and
   * only the first statement was ever classified. `echo hi\nrm -rf ~` came back allow/LOW.
   *
   * This is not only the skill-asset bypass (covered further down): it is a hole in the ordinary
   * classifier that predates the gate entirely.
   */
  describe('newline-separated statements', () => {
    it('classifies a statement on a later line', () => {
      expect(bash('echo hi\nrm -rf /home/u/other')).toMatchObject({ action: 'ask', risk: 'HIGH' })
    })

    it('handles CRLF as well as LF', () => {
      expect(bash('echo hi\r\nrm -rf /home/u/other')).toMatchObject({
        action: 'ask',
        risk: 'HIGH'
      })
    })

    it('still denies a cd out of the sandbox written on a later line', () => {
      expect(bash(`echo hi\n${OUT_OF_SANDBOX_CD}`).action).toBe('deny')
    })

    /**
     * The carve-out, decided by a human. A heredoc BODY is data, not statements: splitting it
     * would raise a spurious "Recursive delete" ask for a line the shell only ever writes into a
     * file, and over-asking on legitimate commands trains exactly the click-through reflex this
     * classification exists to prevent.
     */
    it('does not split the body of a heredoc', () => {
      expect(bash("cat <<'EOF' > notes.txt\nrm -rf /\nEOF")).toEqual({
        action: 'allow',
        risk: 'LOW'
      })
    })

    it.each(['cat <<EOF', 'cat <<-EOF', 'cat << EOF', 'cat <<"EOF"', 'cat <<\\EOF'])(
      'recognises `%s` as opening a heredoc',
      (open) => {
        expect(bash(`${open}\nrm -rf /\nEOF`)).toEqual({ action: 'allow', risk: 'LOW' })
      }
    )

    // `<<<` is a here-STRING: one line, no body, so there is nothing to carve out and the
    // newline split must still apply.
    it('still splits a command containing a here-string', () => {
      expect(bash('cat <<< hi\nrm -rf /home/u/other')).toMatchObject({
        action: 'ask',
        risk: 'HIGH'
      })
    })

    // An arithmetic left shift is not a heredoc, and its operand is a number.
    it('still splits a command containing an arithmetic left shift', () => {
      expect(bash('echo $((1<<3))\nrm -rf /home/u/other')).toMatchObject({
        action: 'ask',
        risk: 'HIGH'
      })
    })

    // Only the NEWLINE is withheld inside a heredoc-bearing command; every other separator still
    // splits it.
    it('keeps the ordinary separators inside a heredoc-bearing command', () => {
      expect(bash("git push && cat <<'EOF'\nhi\nEOF")).toMatchObject({
        action: 'ask',
        risk: 'HIGH'
      })
    })
  })

  it('defaults unknown commands to LOW allow', () => {
    expect(bash('wc -l notes.md')).toMatchObject({ action: 'allow', risk: 'LOW' })
  })
})

describe('classifyToolCall — MCP branch edge names', () => {
  it('does not let "checkout" auto-allow (first word not a LOW/MEDIUM convention word → MEDIUM)', () => {
    expect(classifyToolCall('mcp__foo__checkout_worktree', {}, ctx())).toMatchObject({
      action: 'ask',
      risk: 'MEDIUM'
    })
    expect(classifyToolCall('mcp__x__checkout_worktree', {}, ctx())).toMatchObject({
      action: 'ask',
      risk: 'MEDIUM'
    })
  })

  it('classifies destructive-named tools as HIGH ask (HIGH verbs win anywhere in the name)', () => {
    expect(classifyToolCall('mcp__foo__delete_thing', {}, ctx())).toMatchObject({
      action: 'ask',
      risk: 'HIGH'
    })
  })
})

describe('classifyToolCall — legacy non-MCP unknown-tool fallback', () => {
  it('classifies destructive names as HIGH ask with no grant key', () => {
    expect(classifyToolCall('delete_all_records', {}, ctx())).toMatchObject({
      action: 'ask',
      risk: 'HIGH',
      grantKey: null
    })
    expect(classifyToolCall('merge_branches', {}, ctx())).toMatchObject({
      action: 'ask',
      risk: 'HIGH',
      grantKey: null
    })
  })

  it('auto-allows read-ish prefixes, including legacy-only find/check words', () => {
    expect(classifyToolCall('get_weather', {}, ctx())).toEqual({ action: 'allow', risk: 'LOW' })
    // find/check are legacy-only LOW words (not in the MCP convention's LOW set)
    expect(classifyToolCall('find_symbols', {}, ctx())).toEqual({ action: 'allow', risk: 'LOW' })
    expect(classifyToolCall('check_status', {}, ctx())).toEqual({ action: 'allow', risk: 'LOW' })
  })

  it('does not let "checkout" collide with the read-ish "check" prefix', () => {
    expect(classifyToolCall('checkout_worktree', {}, ctx())).toMatchObject({
      action: 'ask',
      risk: 'MEDIUM'
    })
  })

  it('defaults unmatched names to MEDIUM ask with a medium grant key', () => {
    expect(classifyToolCall('frobnicate_widget', {}, ctx())).toMatchObject({
      action: 'ask',
      risk: 'MEDIUM',
      grantKey: 'medium:frobnicate_widget'
    })
  })
})

describe('MCP connector tools (spec 2.5)', () => {
  const ctx = {
    caseDir: 'C:\\t\\case',
    workspaceRoots: [],
    readonlyRoots: [],
    taxonomy: CLAUDE_TOOL_TAXONOMY
  }

  it('classifies mcp__<instance>__<tool> by name convention', () => {
    expect(classifyToolCall('mcp__rovo__getJiraIssue', {}, ctx)).toEqual({
      action: 'allow',
      risk: 'LOW'
    })
    expect(classifyToolCall('mcp__rovo__addCommentToJiraIssue', {}, ctx)).toMatchObject({
      action: 'ask',
      risk: 'MEDIUM',
      grantKey: 'medium:mcp__rovo__addCommentToJiraIssue'
    })
    expect(classifyToolCall('mcp__rovo__deleteJiraIssue', {}, ctx)).toMatchObject({
      action: 'ask',
      risk: 'HIGH',
      grantKey: null
    })
    expect(classifyToolCall('mcp__rovo__frobnicate', {}, ctx)).toMatchObject({
      action: 'ask',
      risk: 'MEDIUM' // unmatched → MEDIUM (safe default)
    })
  })

  it('tool-risk overrides win over the convention', () => {
    const withOverrides = {
      ...ctx,
      toolRisk: { 'rovo/deleteJiraIssue': 'low', 'rovo/getJiraIssue': 'high' } as const
    }
    expect(classifyToolCall('mcp__rovo__deleteJiraIssue', {}, withOverrides)).toEqual({
      action: 'allow',
      risk: 'LOW'
    })
    expect(classifyToolCall('mcp__rovo__getJiraIssue', {}, withOverrides)).toMatchObject({
      action: 'ask',
      risk: 'HIGH'
    })
  })

  it('native argus table entries are untouched by the MCP branch', () => {
    expect(
      classifyToolCall('mcp__argus__update_case_status', { status: 'open' }, ctx)
    ).toMatchObject({
      action: 'ask',
      risk: 'MEDIUM'
    })
  })
})

describe('classifyToolCall · panel commands + open_panel', () => {
  const pcr = {
    'mcp__sample-bridge-playground__playground_highlight': 'low' as const,
    mcp__pk__win_danger: 'high' as const,
    mcp__pk__win_edit: 'medium' as const
  }
  it('open_panel is allow/LOW', () => {
    expect(classifyToolCall('mcp__argus__open_panel', {}, ctx())).toMatchObject({
      action: 'allow',
      risk: 'LOW'
    })
  })
  it('auto-allows capture_panel as LOW', () => {
    expect(classifyToolCall('mcp__argus__capture_panel', {}, ctx())).toEqual({
      action: 'allow',
      risk: 'LOW'
    })
  })
  it('low command → allow', () => {
    expect(
      classifyToolCall(
        'mcp__sample-bridge-playground__playground_highlight',
        { line: '4' },
        ctx({ panelCommandRisk: pcr })
      )
    ).toMatchObject({ action: 'allow', risk: 'LOW' })
  })
  it('medium command → ask with a session grant key', () => {
    const v = classifyToolCall('mcp__pk__win_edit', {}, ctx({ panelCommandRisk: pcr }))
    expect(v).toMatchObject({ action: 'ask', risk: 'MEDIUM', grantKey: 'medium:mcp__pk__win_edit' })
  })
  it('high command → ask with no session grant', () => {
    expect(
      classifyToolCall('mcp__pk__win_danger', {}, ctx({ panelCommandRisk: pcr }))
    ).toMatchObject({ action: 'ask', risk: 'HIGH', grantKey: null })
  })
})

describe('run_tool_script', () => {
  it('asks before running a model-authored script', () => {
    // The script body is arbitrary JS executed by an ELECTRON_RUN_AS_NODE child that is
    // env-scrubbed but NOT sandboxed — measured against a packaged build: it can read and
    // write the user's home directory and open arbitrary sockets. Argus classifies `Bash`
    // per command; a script with the same reach must not be quieter than that.
    expect(
      classifyToolCall('mcp__argus__run_tool_script', { script: 'console.log(1)' }, ctx())
    ).toMatchObject({ action: 'ask', risk: 'HIGH' })
  })

  it('offers no session grant — every script body is a different program', () => {
    // A grantKey here would mean approving one script silently approves every later one,
    // which is the entire gate.
    const v = classifyToolCall('mcp__argus__run_tool_script', { script: 'x' }, ctx())
    expect(v).toMatchObject({ grantKey: null })
  })
})

describe('tool taxonomy', () => {
  // Reuses the file's top-level ctx() helper, whose default `taxonomy` is already
  // CLAUDE_TOOL_TAXONOMY (see above) — equivalent to the brief's standalone ctx().
  it('classifies Claude FS tools through the taxonomy exactly as before', () => {
    expect(classifyToolCall('Read', { file_path: 'notes.md' }, ctx())).toEqual({
      action: 'allow',
      risk: 'LOW'
    })
    // Absolute and outside the (POSIX) caseDir this ctx declares, on both platforms:
    // 'C:\outside\x' is merely a relative filename on POSIX, so it resolves *inside* the
    // case dir and is correctly allowed there.
    expect(classifyToolCall('Write', { file_path: '/outside/x' }, ctx()).action).toBe('deny')
  })

  it('classifies shell via the taxonomy commandField', () => {
    const v = classifyToolCall('Bash', { command: 'git push' }, ctx())
    expect(v).toMatchObject({ action: 'ask', risk: 'HIGH' })
  })

  it('preserves the legacy heuristic via the Claude fallback', () => {
    // Today: unknown non-MCP names hit the lenient heuristic → MEDIUM ask
    expect(classifyToolCall('TodoWrite', {}, ctx())).toMatchObject({
      action: 'ask',
      risk: 'MEDIUM'
    })
  })

  it('fails closed when the taxonomy has no entry and no fallback', () => {
    const noFallback = ctx({ taxonomy: { entries: CLAUDE_TOOL_TAXONOMY.entries } })
    expect(classifyToolCall('someNewTool', {}, noFallback)).toMatchObject({
      action: 'ask',
      risk: 'HIGH'
    })
    // mcp__ tools still route through the connector branch, not the fail-closed default
    expect(classifyToolCall('mcp__argus__append_finding', {}, noFallback)).toEqual({
      action: 'allow',
      risk: 'LOW'
    })
  })

  it('defaults to FS_PATH_FIELDS when a taxonomy entry omits pathFields', () => {
    // Inline taxonomy entry with no pathFields — exercises `pathFields ?? FS_PATH_FIELDS`.
    const noPathFields: ToolTaxonomy = { entries: { CustomRead: { kind: 'fs-read' } } }
    const c = ctx({ taxonomy: noPathFields })
    // 'path' is one of the built-in default fields; an outside-sandbox value must deny,
    // proving the default field list (not an empty one) governs the lookup.
    expect(classifyToolCall('CustomRead', { path: '/home/u/.ssh/id_rsa' }, c).action).toBe('deny')
    expect(classifyToolCall('CustomRead', { path: `${c.caseDir}/notes.md` }, c).action).toBe(
      'allow'
    )
  })

  it('treats an FS entry whose candidate path fields are all non-strings as caseDir (allow LOW)', () => {
    // Inline taxonomy entry with declared pathFields, but every candidate value below is
    // non-string — `.find(v => typeof v === 'string')` yields undefined, so the lookup
    // falls back to caseDir, which is always in-sandbox.
    const nonStringFields: ToolTaxonomy = {
      entries: { WeirdRead: { kind: 'fs-read', pathFields: ['numField', 'objField'] } }
    }
    const c = ctx({ taxonomy: nonStringFields })
    expect(classifyToolCall('WeirdRead', { numField: 42, objField: { x: 1 } }, c)).toEqual({
      action: 'allow',
      risk: 'LOW'
    })
  })
})

describe('review write tools', () => {
  it('asks at MEDIUM for a PR comment, with no session grant', () => {
    const v = classifyToolCall('mcp__argus__post_review_comment', {}, ctx())
    expect(v).toEqual({
      action: 'ask',
      risk: 'MEDIUM',
      grantKey: null,
      reason: 'Post a comment on a pull request'
    })
  })

  it('asks at HIGH for a push, with no session grant', () => {
    const v = classifyToolCall('mcp__argus__push_review_change', {}, ctx())
    expect(v).toEqual({
      action: 'ask',
      risk: 'HIGH',
      grantKey: null,
      reason: 'Remote mutation: push a commit to the pull request branch'
    })
  })
})

describe("network taxonomy kind (Copilot 'fetch')", () => {
  // A driver taxonomy exercising the 'network' kind. Claude declares none (WebFetch stays
  // on the legacy fallback), so this is exercised only through an inline entry / Copilot.
  const netTax: ToolTaxonomy = { entries: { fetch: { kind: 'network', urlField: 'url' } } }

  it('classifies a fetch as MEDIUM ask with a per-host session grant key', () => {
    const v = classifyToolCall(
      'fetch',
      { url: 'https://example.com/path?q=1' },
      ctx({ taxonomy: netTax })
    )
    expect(v).toEqual({
      action: 'ask',
      risk: 'MEDIUM',
      grantKey: 'net:example.com',
      reason: 'Network egress: https://example.com/path?q=1'
    })
  })

  it('yields an empty host (grantKey "net:") on an unparseable url', () => {
    const v = classifyToolCall('fetch', { url: 'not a url' }, ctx({ taxonomy: netTax }))
    expect(v).toMatchObject({ action: 'ask', risk: 'MEDIUM', grantKey: 'net:' })
  })
})

describe('classifyToolCall — skill asset run gate', () => {
  const asset = (over: Partial<SkillAssetContext> = {}): SkillAssetContext => ({
    skill: 'collect-logs',
    tier: 'user',
    relPath: 'scripts/collect.sh',
    hash: 'a'.repeat(64),
    reviewState: 'reviewed',
    segmentKey: 'f'.repeat(64),
    body: '#!/bin/sh\necho hi\n',
    bodyBytesTotal: 18,
    bodyBytesOmitted: 0,
    ...over
  })

  /**
   * Stands in for `skillAssetGate`'s real `segmentKey`: the one digest form (`sha256Hex`) over
   * the same normalisation the gate applies. Duplicated here on purpose — `risk.ts` only
   * COMPOSES the key, and the normalisation itself is covered against the real filesystem in
   * `skillAssetGate.segment.test.ts`.
   */
  const fakeSegmentKey = (segment: string): string => sha256Hex(segment.trim().replace(/\s+/g, ' '))

  /** Gate every segment that mentions `collect.sh`, nothing else. */
  const gated = (a: SkillAssetContext): RiskContext => ({
    ...ctx(),
    skillAsset: (segment: string) =>
      segment.includes('collect.sh') ? { ...a, segmentKey: fakeSegmentKey(segment) } : null
  })

  const run = (
    command: string,
    a: SkillAssetContext = asset()
  ): ReturnType<typeof classifyToolCall> => classifyToolCall('Bash', { command }, gated(a))

  it('asks at HIGH with a hash-pinned grant key', () => {
    const v = run('bash scripts/collect.sh') as { action: string; risk: string; grantKey: string }
    expect(v).toMatchObject({ action: 'ask', risk: 'HIGH' })
    // The script's content hash still leads the key; the segment digest narrows it (fix 3).
    expect(v.grantKey).toBe(
      `skill-asset:${'a'.repeat(16)}:${fakeSegmentKey('bash scripts/collect.sh').slice(0, 16)}`
    )
  })

  it('keys the same script + same segment identically, spacing aside', () => {
    const a = run('bash scripts/collect.sh') as { grantKey: string }
    const b = run('  bash   scripts/collect.sh  ') as { grantKey: string }
    expect(a.grantKey).toBe(b.grantKey)
  })

  it('changes the grant key when the same script gets different arguments', () => {
    const plain = run('bash scripts/collect.sh') as { grantKey: string }
    const purge = run('bash scripts/collect.sh --purge /') as { grantKey: string }
    const redirect = run('bash scripts/collect.sh > /home/u/.bashrc') as { grantKey: string }
    expect(purge.grantKey).not.toBe(plain.grantKey)
    expect(redirect.grantKey).not.toBe(plain.grantKey)
  })

  it('carries the asset context onto the verdict', () => {
    const v = run('bash scripts/collect.sh')
    expect(v).toMatchObject({ assetContext: { skill: 'collect-logs', reviewState: 'reviewed' } })
  })

  it.each([
    ['reviewed', /reviewed on this machine/],
    ['changed', /changed since/i],
    ['unreviewed', /never reviewed here/i]
  ] as const)('names the %s state in the reason', (reviewState, re) => {
    const v = run('bash scripts/collect.sh', asset({ reviewState }))
    expect((v as { reason: string }).reason).toMatch(re)
  })

  it('keeps the action and risk identical across all three states', () => {
    for (const reviewState of ['reviewed', 'changed', 'unreviewed'] as const) {
      expect(run('bash scripts/collect.sh', asset({ reviewState }))).toMatchObject({
        action: 'ask',
        risk: 'HIGH'
      })
    }
  })

  it('changes the grant key when the bytes change', () => {
    const a = run('bash scripts/collect.sh', asset({ hash: 'a'.repeat(64) })) as {
      grantKey: string
    }
    const b = run('bash scripts/collect.sh', asset({ hash: 'b'.repeat(64) })) as {
      grantKey: string
    }
    expect(a.grantKey).not.toBe(b.grantKey)
  })

  it('gates a whole compound command when one segment runs a skill script', () => {
    expect(run('git log --oneline && bash scripts/collect.sh')).toMatchObject({
      action: 'ask',
      risk: 'HIGH',
      assetContext: { skill: 'collect-logs' }
    })
  })

  // Without this, a `rm -rf` segment (also HIGH ask) would win the merge and the card would
  // show a script approval with no script.
  it('keeps the asset context when another segment is also HIGH', () => {
    expect(run('rm -rf /tmp/x && bash scripts/collect.sh')).toMatchObject({
      action: 'ask',
      risk: 'HIGH',
      assetContext: { skill: 'collect-logs' }
    })
  })

  // The gate runs first WITHIN a segment, but a deny from any other segment still short-circuits
  // the whole command. Reuse whatever out-of-sandbox path this file's existing `cd` deny case
  // uses — do not hard-code `/etc`, which is not out of sandbox on every platform.
  it('still returns a deny from another segment ahead of the gate', () => {
    const v = classifyToolCall(
      'Bash',
      { command: `${OUT_OF_SANDBOX_CD} && bash scripts/collect.sh` },
      gated(asset())
    )
    expect(v.action).toBe('deny')
  })

  // The case above was never at risk: the deny lived in a DIFFERENT segment. This one puts the
  // out-of-sandbox `cd` and the skill-asset path in the SAME segment, which the gate used to
  // short-circuit — turning a deny into a HIGH ask (and, with a stored grant, an auto-allow).
  it('denies a segment that both leaves the sandbox and names a skill script', () => {
    const v = classifyToolCall(
      'Bash',
      { command: `${OUT_OF_SANDBOX_CD} scripts/collect.sh` },
      gated(asset())
    )
    expect(v.action).toBe('deny')
  })

  describe('a command running more than one skill script', () => {
    const a = asset({ skill: 'collect-logs', relPath: 'scripts/collect.sh', hash: 'a'.repeat(64) })
    const b = asset({ skill: 'exfil', relPath: 'run.sh', hash: 'b'.repeat(64) })
    const twoScripts = 'sh scripts/collect.sh && sh exfil/run.sh'
    const ctxTwo: RiskContext = {
      ...ctx(),
      skillAsset: (segment: string) => {
        const hit = segment.includes('collect.sh') ? a : segment.includes('exfil/run.sh') ? b : null
        return hit && { ...hit, segmentKey: fakeSegmentKey(segment) }
      }
    }
    const both = (): { action: string; grantKey: string | null; reason: string } =>
      classifyToolCall('Bash', { command: twoScripts }, ctxTwo) as {
        action: string
        grantKey: string | null
        reason: string
      }

    // The serious half: with the first script's key kept, a session grant earned on
    // `sh scripts/collect.sh` alone would auto-allow this command — running `exfil/run.sh`
    // with no card at all.
    it('refuses a session grant entirely', () => {
      const single = run('sh scripts/collect.sh', a) as { grantKey: string }
      const v = both()
      expect(v.action).toBe('ask')
      expect(v.grantKey).not.toBe(single.grantKey)
      expect(v.grantKey).toBeNull()
    })

    it('says in the reason that more than one skill script is involved', () => {
      expect(both().reason).toMatch(/2 different skill scripts/)
    })

    // Was "still keys a command that names the same script twice". The distinct-hash rule was
    // too narrow (final review round 2, finding A): ANY chained command loses the key now, and
    // naming the same script in both halves is still a chained command.
    it('refuses a grant for a command that names the same script twice', () => {
      const v = classifyToolCall(
        'Bash',
        { command: 'sh scripts/collect.sh && sh scripts/collect.sh' },
        ctxTwo
      ) as { grantKey: string | null }
      expect(v.grantKey).toBeNull()
    })
  })

  /**
   * Final review round 2, finding A. The grant key is computed per SEGMENT but applied to the
   * WHOLE command: the merge keeps the first asset segment's verdict (an asset ask beats a
   * plain ask of equal risk, by design), so before the fix `sh collect.sh && rm -rf ~` carried
   * the identical key to a bare `sh collect.sh` — and a session grant taken on the benign one
   * auto-allowed the chained one with no card at all. That is a regression against main, where
   * every HIGH ask carried a null key and the `rm -rf` always asked.
   */
  describe('a skill script chained with other commands', () => {
    const keyOf = (command: string): string | null =>
      (run(command) as { grantKey: string | null }).grantKey

    it.each([
      ['the same script with different arguments', 'sh scripts/collect.sh --purge /'],
      ['a recursive delete', 'rm -rf /home/u/other'],
      ['a remote mutation', 'git push']
    ])('refuses a session grant when chained with %s', (_label, tail) => {
      const plain = keyOf('sh scripts/collect.sh')
      expect(plain).not.toBeNull()
      const chained = keyOf(`sh scripts/collect.sh && ${tail}`)
      expect(chained).toBeNull()
      expect(chained).not.toBe(plain)
    })

    it('refuses a session grant when piped into another command', () => {
      expect(keyOf('sh scripts/collect.sh | tee /home/u/.bashrc')).toBeNull()
    })

    // The empty-segment filter is load-bearing: a trailing `;` splits into two segments, and
    // without the filter an ordinary one-command invocation would lose its key for a stray
    // separator — killing the loop ergonomics the key exists for.
    it('keeps the key for a trailing separator (an empty second segment)', () => {
      expect(keyOf('sh scripts/collect.sh;')).toBe(keyOf('sh scripts/collect.sh'))
    })

    it('still shows the script and says the command was chained', () => {
      const v = run('sh scripts/collect.sh && rm -rf /home/u/other') as {
        action: string
        risk: string
        assetContext?: SkillAssetContext
        reason: string
      }
      expect(v).toMatchObject({ action: 'ask', risk: 'HIGH' })
      expect(v.assetContext).toMatchObject({ skill: 'collect-logs' })
      expect(v.reason).toMatch(/chained/i)
    })
  })

  /**
   * Final review round 2, finding B. The gate must only ever STRENGTHEN a verdict, and the
   * grant dimension is part of that: a base verdict the classifier deliberately left grantless
   * must not become grantable because the segment happens to name a skill script.
   */
  describe('over a base verdict that deliberately carries no grant key', () => {
    it('keeps rm -rf grantless, with the script still shown', () => {
      const v = run('rm -rf scripts/collect.sh') as {
        action: string
        risk: string
        grantKey: string | null
        assetContext?: SkillAssetContext
        reason: string
      }
      expect(v).toMatchObject({ action: 'ask', risk: 'HIGH', grantKey: null })
      expect(v.assetContext).toMatchObject({ skill: 'collect-logs' })
      expect(v.reason).toMatch(/Recursive delete/)
    })

    it('keeps a gh api non-GET grantless and still names it in the reason', () => {
      const v = run('gh api -X POST /repos/o/r/issues --input scripts/collect.sh') as {
        action: string
        risk: string
        grantKey: string | null
        assetContext?: SkillAssetContext
        reason: string
      }
      expect(v).toMatchObject({ action: 'ask', risk: 'HIGH', grantKey: null })
      expect(v.assetContext).toMatchObject({ skill: 'collect-logs' })
      expect(v.reason).toMatch(/Remote mutation: gh api non-GET/)
      // The asset half still leads it — the card's copy comes from assetContext, but the audit
      // line should read as "runs this script, and it is also a remote mutation".
      expect(v.reason).toMatch(/^Runs scripts\/collect\.sh/)
    })
  })

  it('is inert when no resolver is injected', () => {
    expect(classifyToolCall('Bash', { command: 'bash scripts/collect.sh' }, ctx())).toMatchObject({
      action: 'allow'
    })
  })
})

/**
 * The live-run defect (CDP gate, 2026-08-20): `cd <skillDir> && sh scripts/collect.sh` ran an
 * unreviewed skill script with NO approval card at all — `tool_calls` recorded `Bash / LOW / auto`.
 *
 * Not a path-SPELLING miss like the `/c/…` and `~/…` cases: every token parsed fine. They were
 * resolved against the wrong BASE DIRECTORY. The gate resolved every relative token against the
 * case directory regardless of an earlier `cd`, so `scripts/collect.sh` became
 * `<caseDir>/scripts/collect.sh` (does not exist) and the only other token — the `cd` target — is
 * the skill DIRECTORY, which `skillAssetAt` deliberately refuses. Both tokens missed and the
 * segment fell through to a LOW allow.
 *
 * The stub below RESOLVES its tokens against the cwd it is handed, exactly as the real gate does.
 * A stub that ignored the second argument would pass whether or not the tracking exists.
 */
describe('classifyToolCall — running cwd across shell segments', () => {
  const CASE_DIR = '/home/u/Argus/cases/NAV-1'
  /** What `materializeSessionSkills` junctions into the case directory — the path the model is
   *  told about, and the one the live command `cd`-ed into. */
  const SKILL_DIR = `${CASE_DIR}/.claude/skills/collect-logs`
  const SCRIPT_ABS = `${SKILL_DIR}/scripts/collect.sh`

  const asset: SkillAssetContext = {
    skill: 'collect-logs',
    tier: 'user',
    relPath: 'scripts/collect.sh',
    hash: 'a'.repeat(64),
    reviewState: 'unreviewed',
    segmentKey: 'f'.repeat(64),
    body: '#!/bin/sh\necho hi\n',
    bodyBytesTotal: 18,
    bodyBytesOmitted: 0
  }

  /** Stands in for `skillAssetContextForSegment`: resolve every token against the SUPPLIED cwd
   *  and report the asset when one of them lands on the script. */
  const cwdAware: RiskContext = {
    ...ctx({ caseDir: CASE_DIR }),
    skillAsset: (segment: string, cwd: string) =>
      shellSegmentTokens(segment).some(
        (t) => path.resolve(cwd, t.replace(/^(["'])(.*)\1$/, '$2')) === path.resolve(SCRIPT_ABS)
      )
        ? asset
        : null
  }

  const run = (command: string): ReturnType<typeof classifyToolCall> =>
    classifyToolCall('Bash', { command }, cwdAware)

  // THE regression. Verbatim shape of what the live run executed ungated.
  it('gates `cd <skillDir> && sh scripts/collect.sh`', () => {
    const v = run(`cd "${SKILL_DIR}" && sh scripts/collect.sh`)
    expect(v).toMatchObject({
      action: 'ask',
      risk: 'HIGH',
      assetContext: { skill: 'collect-logs', relPath: 'scripts/collect.sh' }
    })
    // Chained, so no session grant — the pre-existing multi-segment rule, unchanged.
    expect((v as { grantKey: string | null }).grantKey).toBeNull()
  })

  it('gates it unquoted and with the script as the program', () => {
    expect(run(`cd ${SKILL_DIR} && ./scripts/collect.sh`)).toMatchObject({
      action: 'ask',
      risk: 'HIGH',
      assetContext: { skill: 'collect-logs' }
    })
  })

  /**
   * The same live command, one keystroke different. `command.split(/&&|\|\||;|\|/)` did not treat
   * a newline as a separator, so `cd <skillDir>` and `sh scripts/collect.sh` landed in ONE
   * segment; `advanceCwd` runs AFTER a segment is classified, so the `cd` never applied to the
   * token beside it, `scripts/collect.sh` resolved under the case directory and missed, and the
   * segment fell through to allow/LOW with no card — byte-for-byte the failure the `&&` form was
   * fixed for. Models write multi-line Bash commands routinely.
   */
  describe('the same command written across two lines', () => {
    it.each([
      ['LF', '\n'],
      ['CRLF', '\r\n']
    ])('gates `cd <skillDir>%s sh scripts/collect.sh`', (_label, nl) => {
      const v = run(`cd "${SKILL_DIR}"${nl}sh scripts/collect.sh`)
      expect(v).toMatchObject({
        action: 'ask',
        risk: 'HIGH',
        assetContext: { skill: 'collect-logs', relPath: 'scripts/collect.sh' }
      })
      // Two meaningful segments now, so the pre-existing chained-command rule applies.
      expect((v as { grantKey: string | null }).grantKey).toBeNull()
    })

    it('gates the `./scripts/collect.sh` program form across lines', () => {
      expect(run(`cd ${SKILL_DIR}\n./scripts/collect.sh`)).toMatchObject({
        action: 'ask',
        risk: 'HIGH',
        assetContext: { skill: 'collect-logs' }
      })
    })
  })

  /**
   * Finding 3. Two shapes an agent is most likely to reach for next, closed in `cdMove` alone.
   * Treat what is still unmodelled as NOT YET SEEN rather than improbable: `cd <skillDir> && sh
   * <rel>` was on the "unlikely" list right up until a live run executed it.
   */
  describe('a cd wrapped in shell syntax', () => {
    it.each([
      ['a subshell', `( cd ${SKILL_DIR} && sh scripts/collect.sh )`],
      // The OPENING paren glued to the cd is what `cdTokens` strips. A CLOSING paren glued to the
      // last token (`…collect.sh)`) is a different miss — the shared tokenizer hands the gate
      // `scripts/collect.sh)`, which resolves to nothing — and is left as a documented limit.
      ['a subshell with the paren glued on', `(cd ${SKILL_DIR} && sh scripts/collect.sh )`],
      ['a loop body', `for f in *; do cd ${SKILL_DIR} && sh scripts/collect.sh; done`],
      ['an if body', `if true; then cd ${SKILL_DIR} && sh scripts/collect.sh; fi`]
    ])('gates a cd inside %s', (_label, command) => {
      expect(run(command)).toMatchObject({
        action: 'ask',
        risk: 'HIGH',
        assetContext: { skill: 'collect-logs' }
      })
    })
  })

  it('accumulates across several cd segments', () => {
    expect(run(`cd .claude/skills && cd collect-logs && sh scripts/collect.sh`)).toMatchObject({
      action: 'ask',
      risk: 'HIGH',
      assetContext: { skill: 'collect-logs' }
    })
  })

  it('leaves a later ABSOLUTE token alone whatever the cd did', () => {
    expect(run(`cd ${CASE_DIR}/evidence && sh ${SCRIPT_ABS}`)).toMatchObject({
      action: 'ask',
      risk: 'HIGH',
      assetContext: { skill: 'collect-logs' }
    })
  })

  // The other half of "tracked", and the reason this cannot be faked by trying every base: a cd
  // into an unrelated directory must make the same relative token STOP matching.
  it('does not gate a relative token that the tracked cwd does not reach', () => {
    expect(run(`cd ${CASE_DIR}/evidence && sh scripts/collect.sh`)).toEqual({
      action: 'allow',
      risk: 'LOW'
    })
  })

  it('leaves an ordinary cd exactly as it classified before', () => {
    expect(run('cd evidence && ls')).toEqual({ action: 'allow', risk: 'LOW' })
    expect(run(`cd ${CASE_DIR}/evidence`)).toEqual({ action: 'allow', risk: 'LOW' })
  })

  it('still denies a cd out of the sandbox, gate or no gate', () => {
    expect(run(`${OUT_OF_SANDBOX_CD} && sh scripts/collect.sh`).action).toBe('deny')
    expect(run(OUT_OF_SANDBOX_CD).action).toBe('deny')
  })

  /**
   * The cwd itself, observed directly. `classifySegment` calls the injected resolver once per
   * segment with the cwd in force for THAT segment, so recording them pins the tracker's rules
   * without needing a filesystem.
   */
  describe('the cwd each segment is classified against', () => {
    const seenFor = (command: string): string[] => {
      const seen: string[] = []
      classifyToolCall(
        'Bash',
        { command },
        {
          ...ctx({ caseDir: CASE_DIR }),
          skillAsset: (_segment: string, cwd: string) => {
            seen.push(cwd)
            return null
          }
        }
      )
      return seen
    }
    // No parts = the seed, which is `ctx.caseDir` passed through untouched — the classifier does
    // not normalise it, and asserting a `path.resolve`d form would hide that.
    const abs = (...parts: string[]): string =>
      parts.length === 0 ? CASE_DIR : path.resolve(CASE_DIR, ...parts)

    it('seeds at the case directory — the agent shell cwd', () => {
      expect(seenFor('ls')).toEqual([abs()])
    })

    it('advances on a relative cd, and only after that segment', () => {
      expect(seenFor('cd sub && ls && ls')).toEqual([abs(), abs('sub'), abs('sub')])
    })

    it('advances on an in-sandbox absolute cd', () => {
      expect(seenFor(`cd ${CASE_DIR}/evidence && ls`)).toEqual([abs(), abs('evidence')])
    })

    it('is unchanged by a segment that is not a cd', () => {
      expect(seenFor('ls -la && git log')).toEqual([abs(), abs()])
    })

    it('advances on a cd written on its own line', () => {
      expect(seenFor('cd sub\nls\nls')).toEqual([abs(), abs('sub'), abs('sub')])
    })

    // The carve-out, observed at the segment level: a heredoc-bearing command is ONE segment, so
    // the `cd` in the body never moves the tracked cwd — and neither does anything else in it.
    it('leaves a heredoc body unsplit', () => {
      expect(seenFor("cat <<'EOF' > x.sh\ncd sub\nEOF")).toEqual([abs()])
    })

    it.each([
      ['a subshell', '( cd sub && ls )'],
      ['a subshell with the paren glued on', '(cd sub && ls)'],
      ['a loop body', 'for f in *; do cd sub && ls; done'],
      ['a then branch', 'if true; then cd sub && ls; fi'],
      ['an else branch', 'if false; then :; else cd sub && ls; fi'],
      ['a brace group', '{ cd sub && ls; }']
    ])('advances for a cd leading %s', (_label, command) => {
      expect(seenFor(command)).toContain(abs('sub'))
    })

    // `~` is left in the path deliberately: the far side of the seam (`tildeAltPath`) already
    // expands a `~` SEGMENT wherever it sits, so this composes rather than duplicating the
    // home-directory knowledge on the pure side.
    it.each([
      ['a bare cd (the shell goes home)', 'cd', ['~']],
      ['cd ~', 'cd ~', ['~']],
      ['cd ~/Argus/skills-user', 'cd ~/Argus/skills-user', ['~', 'Argus', 'skills-user']]
    ])('marks the home directory with a ~ segment for %s', (_label, cd, parts) => {
      expect(seenFor(`${cd} && ls`)).toEqual([abs(), abs(...parts)])
    })

    it('treats `cd -` as a swap with the previous directory', () => {
      expect(seenFor('cd a && cd - && ls')).toEqual([abs(), abs('a'), abs()])
      expect(seenFor('cd a && cd b && cd - && ls')).toEqual([
        abs(),
        abs('a'),
        abs('a', 'b'),
        abs('a')
      ])
    })

    it('skips cd option flags', () => {
      expect(seenFor('cd -P sub && ls')).toEqual([abs(), abs('sub')])
      expect(seenFor('cd -- sub && ls')).toEqual([abs(), abs('sub')])
    })

    it('strips a matched quote pair from the target', () => {
      expect(seenFor(`cd "sub" && ls`)).toEqual([abs(), abs('sub')])
      expect(seenFor(`cd 'sub' && ls`)).toEqual([abs(), abs('sub')])
    })

    // Documented limit: the shared tokenizer splits on whitespace, so a quoted target containing
    // a space arrives already torn in half. Advancing to the first fragment would point the gate
    // at a directory the command never named, so the cwd is left where it was.
    it('does not advance on a target containing a space', () => {
      expect(seenFor(`cd "sub dir" && ls`)).toEqual([abs(), abs()])
    })

    // Only the shell BUILTIN changes the shell's directory; `/usr/bin/cd` is a separate process
    // whose chdir dies with it. Matching it here would point the gate at a directory the shell
    // never entered, and a wrong base is a MISSED card.
    it('does not advance for a path-spelled cd', () => {
      expect(seenFor('/usr/bin/cd sub && ls')).toEqual([abs(), abs()])
    })
  })
})
