import path from 'node:path'
import { describe, it, expect } from 'vitest'
import { classifyToolCall, type RiskContext } from '../risk'

function ctx(overrides: Partial<RiskContext> = {}): RiskContext {
  return {
    caseDir: '/home/u/Argus/cases/NAV-1',
    workspaceRoots: ['/home/u/code/navigator', '/home/u/Argus/worktrees'],
    readonlyRoots: ['/home/u/Argus/skills', '/home/u/Argus/references'],
    ...overrides
  }
}

function bash(command: string): ReturnType<typeof classifyToolCall> {
  return classifyToolCall('Bash', { command }, ctx())
}

describe('classifyToolCall — native and FS tools', () => {
  it.each([
    ['mcp__argus__search_evidence', 'allow', 'LOW'],
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

  it('write_memory is MEDIUM ask with no session grant', () => {
    const v = classifyToolCall('mcp__argus__write_memory', { topic: 't', content: 'c' }, ctx())
    expect(v).toEqual({
      action: 'ask',
      risk: 'MEDIUM',
      grantKey: null,
      reason: 'Write to agent memory (steers all future sessions)'
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
  const ctx = { caseDir: 'C:\\t\\case', workspaceRoots: [], readonlyRoots: [] }

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
    'mcp__pk__win_danger': 'high' as const,
    'mcp__pk__win_edit': 'medium' as const
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
