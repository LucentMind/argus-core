import path from 'node:path'
import { describe, it, expect } from 'vitest'
import { classifyToolCall, type RiskContext } from '../risk'

const ctx: RiskContext = {
  caseDir: '/home/u/Argus/cases/NAV-1',
  workspaceRoots: ['/home/u/code/navigator', '/home/u/Argus/worktrees'],
  readonlyRoots: ['/home/u/Argus/skills', '/home/u/Argus/references']
}

function bash(command: string): ReturnType<typeof classifyToolCall> {
  return classifyToolCall('Bash', { command }, ctx)
}

describe('classifyToolCall — native and FS tools', () => {
  it.each([
    ['mcp__argus__search_evidence', 'allow', 'LOW'],
    ['mcp__argus__append_finding', 'allow', 'LOW'],
    ['mcp__argus__update_case_status', 'ask', 'MEDIUM'],
    ['mcp__argus__workspace_checkout', 'ask', 'MEDIUM']
  ] as const)('%s → %s/%s', (tool, action, risk) => {
    const v = classifyToolCall(tool, {}, ctx)
    expect(v.action).toBe(action)
    expect(v.risk).toBe(risk)
  })

  it('allows Read inside the case dir, denies outside the sandbox', () => {
    expect(
      classifyToolCall('Read', { file_path: `${ctx.caseDir}/evidence/a.txt` }, ctx).action
    ).toBe('allow')
    expect(classifyToolCall('Read', { file_path: '/home/u/.ssh/id_rsa' }, ctx).action).toBe('deny')
  })

  it('denies Write into read-only roots, allows in case dir', () => {
    expect(
      classifyToolCall('Write', { file_path: '/home/u/Argus/skills/x/SKILL.md' }, ctx).action
    ).toBe('deny')
    expect(classifyToolCall('Write', { file_path: `${ctx.caseDir}/notes.md` }, ctx).action).toBe(
      'allow'
    )
  })

  it('resolves relative and missing FS paths against caseDir instead of bypassing the sandbox', () => {
    // relative path traversal that escapes the sandbox entirely -> deny
    expect(classifyToolCall('Read', { file_path: '../../../../etc/passwd' }, ctx).action).toBe(
      'deny'
    )
    // relative path that stays inside caseDir -> allow
    expect(classifyToolCall('Read', { file_path: 'evidence/a.txt' }, ctx).action).toBe('allow')
    // relative path that escapes into a readonly root -> deny (write)
    const relIntoReadonly = path.relative(ctx.caseDir, `${ctx.readonlyRoots[0]}/x/SKILL.md`)
    expect(classifyToolCall('Write', { file_path: relIntoReadonly }, ctx).action).toBe('deny')
    // missing path input -> treated as cwd (caseDir) -> allow
    expect(classifyToolCall('Glob', {}, ctx).action).toBe('allow')
  })
})

describe('classifyToolCall — Bash', () => {
  it.each([
    ['git log --oneline -5', 'allow', 'LOW'],
    ['git blame src/router.cc', 'allow', 'LOW'],
    ['git -C /home/u/code/navigator diff HEAD~1', 'allow', 'LOW'],
    ['sample-trace find-navigator-errors evidence/applog.txt', 'allow', 'LOW'],
    ['sample-parse binlog-to-text evidence/trace.binlog', 'allow', 'LOW']
  ] as const)('%s → auto-allow', (cmd, action, risk) => {
    const v = bash(cmd)
    expect(v.action).toBe(action)
    expect(v.risk).toBe(risk)
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

  it('nudges raw grep/cat on evidence files to sample-trace (MEDIUM ask)', () => {
    for (const cmd of ['grep -c error evidence/applog.txt', 'cat evidence/applog.txt']) {
      const v = bash(cmd)
      expect(v).toMatchObject({ action: 'ask', risk: 'MEDIUM' })
      if (v.action === 'ask') expect(v.reason).toContain('sample-trace')
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

describe('classifyToolCall — unknown-tool fallback', () => {
  it('does not let "checkout" collide with the read-ish "check" prefix', () => {
    expect(classifyToolCall('mcp__foo__checkout_worktree', {}, ctx)).toMatchObject({
      action: 'ask',
      risk: 'MEDIUM'
    })
    expect(classifyToolCall('mcp__x__checkout_worktree', {}, ctx)).toMatchObject({
      action: 'ask',
      risk: 'MEDIUM'
    })
  })

  it('classifies destructive-named tools as HIGH ask even before the read-ish check', () => {
    expect(classifyToolCall('mcp__foo__delete_thing', {}, ctx)).toMatchObject({
      action: 'ask',
      risk: 'HIGH'
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
