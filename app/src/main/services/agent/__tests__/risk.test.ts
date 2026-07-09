import { describe, it, expect } from 'vitest'
import { classifyToolCall, type RiskContext } from '../risk'

const ctx: RiskContext = {
  caseDir: '/home/u/Argus/cases/NAV-1',
  workspaceRoots: ['/home/u/code/navigator', '/home/u/Argus/worktrees'],
  readonlyRoots: ['/home/u/Argus/skills', '/home/u/Argus/references']
}

function bash(command: string) {
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
    expect(classifyToolCall('Read', { file_path: `${ctx.caseDir}/evidence/a.txt` }, ctx).action).toBe('allow')
    expect(classifyToolCall('Read', { file_path: '/home/u/.ssh/id_rsa' }, ctx).action).toBe('deny')
  })

  it('denies Write into read-only roots, allows in case dir', () => {
    expect(classifyToolCall('Write', { file_path: '/home/u/Argus/skills/x/SKILL.md' }, ctx).action).toBe('deny')
    expect(classifyToolCall('Write', { file_path: `${ctx.caseDir}/notes.md` }, ctx).action).toBe('allow')
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
    ['git fetch origin', 'ws'],
    ['git switch feature/x', 'ws'],
    ['git checkout v3.16.0', 'ws'],
    ['gh pr checkout 1234', 'ws']
  ] as const)('%s → MEDIUM ask with workspace grant key', (cmd) => {
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

  it('defaults unknown commands to LOW allow', () => {
    expect(bash('wc -l notes.md')).toMatchObject({ action: 'allow', risk: 'LOW' })
  })
})
