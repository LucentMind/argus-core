import path from 'node:path'
import type { Risk } from '../../../shared/agent-events'
import { classifyToolName, type RiskLevel } from '../../../shared/connectors'

export interface RiskContext {
  caseDir: string
  workspaceRoots: string[]
  readonlyRoots: string[]
  /** Live overrides from config/tool-risk.json, keyed '<instanceId>/<toolName>'. */
  toolRisk?: Record<string, RiskLevel>
  /** Pack-declared CLI binary names (PackRegistry.binaryDecls), auto-allowlisted as LOW. */
  packCliNames?: string[]
  /** Per-command risk for pack panel commands, keyed by full tool name (3b-2). */
  panelCommandRisk?: Record<string, 'low' | 'medium' | 'high'>
}

export type RiskVerdict =
  | { action: 'allow'; risk: Risk }
  | { action: 'ask'; risk: Risk; grantKey: string | null; reason: string }
  | { action: 'deny'; risk: Risk; reason: string }

const NATIVE_RISK: Record<string, RiskVerdict> = {
  mcp__argus__search_evidence: { action: 'allow', risk: 'LOW' },
  mcp__argus__list_evidence: { action: 'allow', risk: 'LOW' },
  mcp__argus__get_artifact_meta: { action: 'allow', risk: 'LOW' },
  mcp__argus__ingest_artifact: { action: 'allow', risk: 'LOW' },
  mcp__argus__append_finding: { action: 'allow', risk: 'LOW' },
  mcp__argus__read_memory: { action: 'allow', risk: 'LOW' },
  // Inert until accepted on the Skills page (spec §2.4) — writing a proposal steers nothing.
  mcp__argus__write_proposal: { action: 'allow', risk: 'LOW' },
  mcp__argus__open_panel: { action: 'allow', risk: 'LOW' },
  mcp__argus__capture_panel: { action: 'allow', risk: 'LOW' },
  mcp__argus__update_case_status: {
    action: 'ask',
    risk: 'MEDIUM',
    grantKey: null,
    reason: 'Case lifecycle change'
  },
  mcp__argus__workspace_checkout: {
    action: 'ask',
    risk: 'MEDIUM',
    grantKey: 'ws:workspace_checkout',
    reason: 'Materialize a case worktree at a specific ref'
  },
  mcp__argus__write_memory: {
    action: 'ask',
    risk: 'MEDIUM',
    grantKey: null,
    reason: 'Write to agent memory (steers all future sessions)'
  }
}

const FS_READ_TOOLS = ['Read', 'Glob', 'Grep', 'NotebookRead']
const FS_WRITE_TOOLS = ['Write', 'Edit', 'NotebookEdit']

const GIT_READ = new Set([
  'log',
  'show',
  'diff',
  'blame',
  'status',
  'grep',
  'rev-parse',
  'ls-files',
  'remote',
  'branch',
  'describe',
  'shortlog'
])
const GIT_WS_MUT = new Set([
  'fetch',
  'pull',
  'switch',
  'checkout',
  'stash',
  'worktree',
  'reset',
  'restore',
  'clean'
])
const GH_READ = new Set(['view', 'list', 'diff', 'status', 'checks'])

function withinAny(p: string, roots: string[]): boolean {
  const abs = path.resolve(p)
  return roots.some((r) => abs === path.resolve(r) || abs.startsWith(path.resolve(r) + path.sep))
}

function inSandbox(p: string, ctx: RiskContext): boolean {
  return withinAny(p, [ctx.caseDir, ...ctx.workspaceRoots, ...ctx.readonlyRoots])
}

function classifyGit(tokens: string[]): RiskVerdict {
  // skip global flags/-C <path> to find the subcommand
  let i = 1
  let repo = 'cwd'
  while (i < tokens.length) {
    if (tokens[i] === '-C' && tokens[i + 1]) {
      repo = tokens[i + 1]
      i += 2
    } else if (tokens[i].startsWith('-')) i++
    else break
  }
  const sub = tokens[i] ?? ''
  if (sub === 'push')
    return { action: 'ask', risk: 'HIGH', grantKey: null, reason: 'Remote mutation: git push' }
  if (GIT_WS_MUT.has(sub))
    return {
      action: 'ask',
      risk: 'MEDIUM',
      grantKey: `ws:${repo}`,
      reason: `Workspace mutation: git ${sub}`
    }
  if (GIT_READ.has(sub)) return { action: 'allow', risk: 'LOW' }
  return {
    action: 'ask',
    risk: 'MEDIUM',
    grantKey: `ws:${repo}`,
    reason: `Unrecognized git subcommand: ${sub}`
  }
}

function classifyGh(tokens: string[]): RiskVerdict {
  const [, group, sub] = tokens
  if (group === 'auth' && sub === 'status') return { action: 'allow', risk: 'LOW' }
  if (group === 'api') {
    const hasMutMethod = tokens.some(
      (t, i) =>
        (t === '-X' || t === '--method') && /^(POST|PUT|PATCH|DELETE)$/i.test(tokens[i + 1] ?? '')
    )
    return hasMutMethod
      ? { action: 'ask', risk: 'HIGH', grantKey: null, reason: 'Remote mutation: gh api non-GET' }
      : { action: 'allow', risk: 'LOW' }
  }
  if (group === 'pr' && sub === 'checkout')
    return {
      action: 'ask',
      risk: 'MEDIUM',
      grantKey: 'ws:cwd',
      reason: 'Workspace mutation: gh pr checkout'
    }
  if (GH_READ.has(sub)) return { action: 'allow', risk: 'LOW' }
  return {
    action: 'ask',
    risk: 'HIGH',
    grantKey: null,
    reason: `Remote mutation: gh ${group} ${sub ?? ''}`.trim()
  }
}

function classifySegment(segment: string, ctx: RiskContext): RiskVerdict {
  const tokens = segment.trim().split(/\s+/).filter(Boolean)
  // skip leading VAR=val assignments
  while (tokens.length && /^[A-Za-z_][A-Za-z0-9_]*=/.test(tokens[0])) tokens.shift()
  if (tokens.length === 0) return { action: 'allow', risk: 'LOW' }
  const prog = path.basename(tokens[0])

  if (prog === 'git') return classifyGit(tokens)
  if (prog === 'gh') return classifyGh(tokens)
  if (prog === 'rm' && tokens.some((t) => /^-[a-zA-Z]*r/i.test(t) || t === '--recursive'))
    return { action: 'ask', risk: 'HIGH', grantKey: null, reason: 'Recursive delete' }
  if (prog === 'cd') {
    const target = tokens[1]
    if (target && path.isAbsolute(target) && !inSandbox(target, ctx))
      return { action: 'deny', risk: 'HIGH', reason: `Path outside sandbox: ${target}` }
    return { action: 'allow', risk: 'LOW' }
  }
  // Builtin classifiers above always win; the pack allowlist only applies to CLIs that
  // don't collide with git/gh/rm/cd (enforced at the manifest schema level too).
  if (ctx.packCliNames?.includes(prog)) return { action: 'allow', risk: 'LOW' }
  if (['grep', 'rg', 'cat', 'awk', 'sed', 'head', 'tail'].includes(prog)) {
    const touchesEvidence = tokens
      .slice(1)
      .some((t) => t.startsWith('evidence/') || t.includes('/evidence/'))
    if (touchesEvidence)
      return {
        action: 'ask',
        risk: 'MEDIUM',
        grantKey: null,
        reason: ctx.packCliNames?.length
          ? `Use the pack analysis CLIs (${ctx.packCliNames.join(', ')}) for evidence files instead of raw text tools`
          : 'Raw text tools are discouraged on evidence files — they have no guardrails or output caps'
      }
  }
  // absolute-path writes/reads are governed by the FS sandbox for FS tools; for bash we
  // only police cd/rm; everything else defaults LOW inside the session cwd.
  return { action: 'allow', risk: 'LOW' }
}

const RISK_ORDER: Risk[] = ['LOW', 'MEDIUM', 'HIGH']

export function classifyToolCall(
  toolName: string,
  input: Record<string, unknown>,
  ctx: RiskContext
): RiskVerdict {
  const native = NATIVE_RISK[toolName]
  if (native) return native

  const pcRisk = ctx.panelCommandRisk?.[toolName]
  if (pcRisk) {
    if (pcRisk === 'low') return { action: 'allow', risk: 'LOW' }
    if (pcRisk === 'high')
      return { action: 'ask', risk: 'HIGH', grantKey: null, reason: `Panel command: ${toolName}` }
    return {
      action: 'ask',
      risk: 'MEDIUM',
      grantKey: `medium:${toolName}`,
      reason: `Panel command: ${toolName}`
    }
  }

  if (FS_READ_TOOLS.includes(toolName) || FS_WRITE_TOOLS.includes(toolName)) {
    const p = (input.file_path ?? input.path ?? input.notebook_path) as string | undefined
    // The agent session's cwd is always ctx.caseDir, so a missing or relative path
    // resolves against it. A missing path means "cwd" -> caseDir -> allowed.
    const abs = p ? path.resolve(ctx.caseDir, p) : ctx.caseDir
    if (!inSandbox(abs, ctx))
      return { action: 'deny', risk: 'HIGH', reason: `Path outside sandbox: ${p ?? abs}` }
    if (FS_WRITE_TOOLS.includes(toolName) && withinAny(abs, ctx.readonlyRoots))
      return { action: 'deny', risk: 'HIGH', reason: `Read-only root: ${p ?? abs}` }
    return { action: 'allow', risk: 'LOW' }
  }

  if (toolName === 'Bash') {
    const command = String(input.command ?? '')
    const segments = command.split(/&&|\|\||;|\|/)
    let worst: RiskVerdict = { action: 'allow', risk: 'LOW' }
    for (const seg of segments) {
      const v = classifySegment(seg, ctx)
      if (v.action === 'deny') return v
      const worse =
        RISK_ORDER.indexOf(v.risk) > RISK_ORDER.indexOf(worst.risk) ||
        (v.action === 'ask' && worst.action === 'allow')
      if (worse) worst = v
    }
    return worst
  }

  // Connector (MCP) tools: tool-risk.json overrides, else spec §2.5 name convention.
  const mcp = toolName.match(/^mcp__(.+?)__(.+)$/)
  if (mcp) {
    const level = ctx.toolRisk?.[`${mcp[1]}/${mcp[2]}`] ?? classifyToolName(mcp[2])
    if (level === 'low') return { action: 'allow', risk: 'LOW' }
    if (level === 'high')
      return {
        action: 'ask',
        risk: 'HIGH',
        grantKey: null,
        reason: `Destructive connector tool: ${toolName}`
      }
    return {
      action: 'ask',
      risk: 'MEDIUM',
      grantKey: `medium:${toolName}`,
      reason: `Write-capable connector tool: ${toolName}`
    }
  }

  // Non-MCP unknown tools: legacy heuristic, unchanged.
  const last = toolName.split('__').pop() ?? toolName
  if (/(delete|remove|transition|merge)/.test(last))
    return { action: 'ask', risk: 'HIGH', grantKey: null, reason: `Destructive tool: ${toolName}` }
  if (/^(get|list|read|search|view|find|check)(_|$)/.test(last))
    return { action: 'allow', risk: 'LOW' }
  return {
    action: 'ask',
    risk: 'MEDIUM',
    grantKey: `medium:${toolName}`,
    reason: `Write-capable tool: ${toolName}`
  }
}
