import path from 'node:path'
import type { Risk, SkillAssetContext } from '../../../shared/agent-events'
import { classifyToolName, type RiskLevel } from '../../../shared/connectors'
import { fillPrompt } from '../prompts/fill'
import type { PromptTextSpecs } from '../../../shared/promptSpec'

export type ToolTaxonomyEntry =
  | { kind: 'fs-read' | 'fs-write'; pathFields?: readonly string[] }
  | { kind: 'shell'; commandField: string }
  | { kind: 'network'; urlField: string }

export interface ToolTaxonomy {
  entries: Readonly<Record<string, ToolTaxonomyEntry>>
  /** Driver-declared fallback for its own long tail of non-MCP tools.
   *  Absent → unmapped names fail closed (HIGH ask). */
  fallback?: (toolName: string) => RiskVerdict
}

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
  /** Driver-declared mapping from its native tool names to risk-relevant shape. */
  taxonomy: ToolTaxonomy
  /** Prompt-registry resolver for `RISK_DENY_REASONS`. Optional: callers without a store get
   *  the defaults. */
  resolve?: (id: string) => string
  /**
   * Resolve one shell segment to the skill asset it would execute, or null.
   *
   * Injected rather than imported: this module does no filesystem or database access and must
   * keep doing none — the gate needs both, and a classifier that reached for them could not be
   * unit-tested with a plain object. Absent means the gate is off, which is what every existing
   * caller and every driver-mapping test gets.
   */
  skillAsset?: (segment: string) => SkillAssetContext | null
}

export type RiskVerdict =
  | { action: 'allow'; risk: Risk }
  | {
      action: 'ask'
      risk: Risk
      grantKey: string | null
      reason: string
      /** Set only by the skill-asset gate. `session.ts` forwards it onto `request.opened`;
       *  it is the only channel by which the card learns anything about the script, since
       *  `reason` does not reach the card (see the comment above `NATIVE_RISK`). */
      assetContext?: SkillAssetContext
    }
  | { action: 'deny'; risk: Risk; reason: string }

/**
 * The only risk text that reaches the model. `session.ts` forwards `verdict.reason` as the
 * tool_result on a DENY. On an ASK, `verdict.reason` does NOT reach the approval card — the
 * card is built from `{requestId, tool, risk, grantKey, argsPreview}` plus, for a skill-asset
 * ask, `assetContext` (session.ts's `handleToolRequest`), and a refusal sends
 * `outcome.comment ?? 'Denied by user'` back to the model instead. An ASK's `reason` is logged
 * to the audit trail (`logToolCall`) but otherwise unused, so these are deliberately not
 * registered as user-facing copy.
 */
export const RISK_DENY_REASONS: PromptTextSpecs = {
  'risk.path-outside-sandbox': {
    title: 'Denied — path outside the sandbox',
    text: 'Path outside sandbox: {path}',
    placeholders: ['path']
  },
  'risk.readonly-root': {
    title: 'Denied — write under a read-only root',
    text: 'Read-only root: {path}',
    placeholders: ['path']
  }
}

/** Resolve one deny reason and fill in the offending path. No resolver = the default. */
function denyReason(ctx: RiskContext, key: string, pathValue: string): string {
  const text = ctx.resolve ? ctx.resolve(`tool-feedback.${key}`) : RISK_DENY_REASONS[key].text
  return fillPrompt(text, { path: pathValue })
}

/** Canonical Argus native-tool risk verdicts (keyed by `mcp__argus__<name>`). Exported so
 *  drivers can decide per-tool permission gating: a driver may bypass its SDK permission
 *  channel (Copilot `skipPermission`) for tools whose action is 'allow' (LOW), exactly as
 *  Claude auto-allows them. */
export const NATIVE_RISK: Record<string, RiskVerdict> = {
  mcp__argus__search_evidence: { action: 'allow', risk: 'LOW' },
  mcp__argus__search_case_history: { action: 'allow', risk: 'LOW' },
  mcp__argus__search_known_defects: { action: 'allow', risk: 'LOW' },
  mcp__argus__list_evidence: { action: 'allow', risk: 'LOW' },
  mcp__argus__get_artifact_meta: { action: 'allow', risk: 'LOW' },
  mcp__argus__read_lines: { action: 'allow', risk: 'LOW' },
  mcp__argus__grep_lines: { action: 'allow', risk: 'LOW' },
  mcp__argus__ingest_artifact: { action: 'allow', risk: 'LOW' },
  mcp__argus__append_finding: { action: 'allow', risk: 'LOW' },
  mcp__argus__read_memory: { action: 'allow', risk: 'LOW' },
  // NOT sandboxed: the PTC child is a plain ELECTRON_RUN_AS_NODE process (env-scrubbed, but
  // otherwise full user-level fs/network access) — the script's own code runs unsandboxed as
  // the user. Measured against a packaged build 2026-08-18: the child read and wrote the user's
  // home directory and opened an arbitrary socket. What IS restricted are the inner TOOL calls
  // the script can make: the PTC server allowlist limits it to the read-only
  // PTC_FOREGROUND_TOOLS set, and each is individually risk-checked when dispatched.
  //
  // So the script BODY has the reach of a shell command, and Argus classifies `Bash` per
  // command — this must not be quieter than that. `grantKey: null` is the load-bearing half:
  // a session grant would make approving one script silently approve every later one, and
  // unlike a shell command with a stable shape, every script body is a different program.
  //
  // Applies to interactive sessions only. The background distiller reaches this tool through
  // its own canUseTool whitelist (DISTILL_ALLOWED_TOOLS), which never consults this table —
  // gating here does not stall a headless run.
  mcp__argus__run_tool_script: {
    action: 'ask',
    risk: 'HIGH',
    grantKey: null,
    reason: 'Runs a model-authored script on your machine, unsandboxed and as you'
  },
  // Inert until accepted on the Proposals page (spec §2.4) — writing a proposal steers nothing.
  mcp__argus__write_proposal: { action: 'allow', risk: 'LOW' },
  // A read: pulls a CI job log into evidence. Spec §8 — "reads (fetch PR/CI/diff/logs) auto-run
  // and are logged". Ingesting is a local write, but of content the user already has access to
  // and asked for; the HITL bar is for writes that leave the machine.
  mcp__argus__fetch_check_logs: { action: 'allow', risk: 'LOW' },
  mcp__argus__open_panel: { action: 'allow', risk: 'LOW' },
  mcp__argus__capture_panel: { action: 'allow', risk: 'LOW' },
  // Inert until a human accepts it in the Home inbox (spec §5.3): the suggestion is written to
  // routine_run_items, never to the case. Same rationale as write_proposal above. WITHOUT this
  // entry it falls to the taxonomy fallback, which reads it as write-capable and ASKS — and an
  // unattended routine turn denies every ask, so the one tool the item loop exists to call is
  // denied on every item, always.
  mcp__argus__propose_case_triage: { action: 'allow', risk: 'LOW' },
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
    reason: "Replace an agent-memory topic's whole body (steers all future sessions)"
  },
  mcp__argus__post_review_comment: {
    action: 'ask',
    risk: 'MEDIUM',
    grantKey: null,
    reason: 'Post a comment on a pull request'
  },
  mcp__argus__push_review_change: {
    action: 'ask',
    risk: 'HIGH',
    grantKey: null,
    reason: 'Remote mutation: push a commit to the pull request branch'
  }
}

const FS_PATH_FIELDS = ['file_path', 'path', 'notebook_path'] as const

export const CLAUDE_TOOL_TAXONOMY: ToolTaxonomy = {
  entries: {
    Read: { kind: 'fs-read', pathFields: FS_PATH_FIELDS },
    Glob: { kind: 'fs-read', pathFields: FS_PATH_FIELDS },
    Grep: { kind: 'fs-read', pathFields: FS_PATH_FIELDS },
    NotebookRead: { kind: 'fs-read', pathFields: FS_PATH_FIELDS },
    Write: { kind: 'fs-write', pathFields: FS_PATH_FIELDS },
    Edit: { kind: 'fs-write', pathFields: FS_PATH_FIELDS },
    NotebookEdit: { kind: 'fs-write', pathFields: FS_PATH_FIELDS },
    Bash: { kind: 'shell', commandField: 'command' }
  },
  // The pre-taxonomy legacy heuristic, relocated verbatim — Claude's built-in long
  // tail (TodoWrite, WebFetch, Task, …) keeps today's classification exactly.
  fallback: (toolName) => {
    const last = toolName.split('__').pop() ?? toolName
    if (/(delete|remove|transition|merge)/.test(last))
      return {
        action: 'ask',
        risk: 'HIGH',
        grantKey: null,
        reason: `Destructive tool: ${toolName}`
      }
    if (/^(get|list|read|search|view|find|check)(_|$)/.test(last))
      return { action: 'allow', risk: 'LOW' }
    return {
      action: 'ask',
      risk: 'MEDIUM',
      grantKey: `medium:${toolName}`,
      reason: `Write-capable tool: ${toolName}`
    }
  }
}

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
  // Every `gh search <repos|issues|prs|commits|code>` subcommand is read-only. Matched on
  // the group, not GH_READ: GH_READ is tested against `sub`, and here `search` is the
  // group ("gh search prs"), so a GH_READ entry would never fire for it.
  if (group === 'search') return { action: 'allow', risk: 'LOW' }
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

/**
 * Splits a shell segment into whitespace tokens, dropping leading `VAR=value` assignments.
 *
 * Shared between the risk classifier and the skill-asset run gate (`skillAssetGate.ts`)
 * deliberately: two different splits would disagree about which token is the program exactly
 * once, and a mismatch there would let a script the gate should have caught run unreviewed, or
 * flag a token the classifier never treated as the program.
 */
export function shellSegmentTokens(segment: string): string[] {
  const tokens = segment.trim().split(/\s+/).filter(Boolean)
  while (tokens.length && /^[A-Za-z_][A-Za-z0-9_]*=/.test(tokens[0])) tokens.shift()
  return tokens
}

/** The three §7.2 states differ only in what the card says; action and risk are identical. */
function assetReason(a: SkillAssetContext): string {
  const what = `Runs ${a.relPath} from the "${a.skill}" skill`
  if (a.reviewState === 'reviewed') return `${what} — reviewed on this machine`
  if (a.reviewState === 'changed') return `${what} — CHANGED since you reviewed it`
  return `${what} — never reviewed here`
}

function classifySegment(segment: string, ctx: RiskContext): RiskVerdict {
  // The skill-asset gate runs before the program-name dispatch: what matters is the FILE a
  // segment executes, not whether the program is `bash`, `sh`, `python`, or the script itself.
  // A gate, not a sandbox (spec §7.4) — see `skillAssetContextForSegment` for what it cannot see:
  // `bash "$(cat target)"`, a script piped to an interpreter's stdin, and a dynamically built
  // path are all out of reach and fall back to ordinary shell classification below.
  const asset = ctx.skillAsset?.(segment)
  if (asset) {
    return {
      action: 'ask',
      risk: 'HIGH',
      // The content hash, deliberately not null: the body is a stable, named, previously
      // reviewed file, so a session grant is reasonable — and pinning the key to the hash kills
      // that grant the instant the bytes change, including mid-session after a HiveMind pull.
      // `null` would re-prompt on every iteration of a loop that calls the script ten times,
      // training exactly the click-through reflex this gate exists to prevent.
      grantKey: `skill-asset:${asset.hash.slice(0, 16)}`,
      reason: assetReason(asset),
      assetContext: asset
    }
  }
  const tokens = shellSegmentTokens(segment)
  if (tokens.length === 0) return { action: 'allow', risk: 'LOW' }
  const prog = path.basename(tokens[0])

  if (prog === 'git') return classifyGit(tokens)
  if (prog === 'gh') return classifyGh(tokens)
  if (prog === 'rm' && tokens.some((t) => /^-[a-zA-Z]*r/i.test(t) || t === '--recursive'))
    return { action: 'ask', risk: 'HIGH', grantKey: null, reason: 'Recursive delete' }
  if (prog === 'cd') {
    const target = tokens[1]
    if (target && path.isAbsolute(target) && !inSandbox(target, ctx))
      return {
        action: 'deny',
        risk: 'HIGH',
        reason: denyReason(ctx, 'risk.path-outside-sandbox', target)
      }
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

/**
 * Is `v` a worse verdict than the running worst? The first two rules are the original merge,
 * verbatim: higher risk wins, and an ask beats an allow even at lower risk. The third is new —
 * at equal risk, a verdict carrying asset context beats one without, because losing it would
 * show a reviewer a script's approval prompt with no script in it.
 */
function isWorse(v: RiskVerdict, worst: RiskVerdict): boolean {
  if (RISK_ORDER.indexOf(v.risk) > RISK_ORDER.indexOf(worst.risk)) return true
  if (v.action === 'ask' && worst.action === 'allow') return true
  if (RISK_ORDER.indexOf(v.risk) !== RISK_ORDER.indexOf(worst.risk)) return false
  return (
    v.action === 'ask' &&
    worst.action === 'ask' &&
    v.assetContext !== undefined &&
    worst.assetContext === undefined
  )
}

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

  const tax = ctx.taxonomy.entries[toolName]
  if (tax && (tax.kind === 'fs-read' || tax.kind === 'fs-write')) {
    const fields = tax.pathFields ?? FS_PATH_FIELDS
    const p = fields.map((f) => input[f]).find((v) => typeof v === 'string') as string | undefined
    // The agent session's cwd is always ctx.caseDir, so a missing or relative path
    // resolves against it. A missing path means "cwd" -> caseDir -> allowed.
    const abs = p ? path.resolve(ctx.caseDir, p) : ctx.caseDir
    if (!inSandbox(abs, ctx))
      return {
        action: 'deny',
        risk: 'HIGH',
        reason: denyReason(ctx, 'risk.path-outside-sandbox', p ?? abs)
      }
    if (tax.kind === 'fs-write' && withinAny(abs, ctx.readonlyRoots))
      return {
        action: 'deny',
        risk: 'HIGH',
        reason: denyReason(ctx, 'risk.readonly-root', p ?? abs)
      }
    return { action: 'allow', risk: 'LOW' }
  }

  if (tax && tax.kind === 'shell') {
    const command = String(input[tax.commandField] ?? '')
    const segments = command.split(/&&|\|\||;|\|/)
    let worst: RiskVerdict = { action: 'allow', risk: 'LOW' }
    for (const seg of segments) {
      const v = classifySegment(seg, ctx)
      if (v.action === 'deny') return v
      if (isWorse(v, worst)) worst = v
    }
    return worst
  }

  // Network egress (Copilot `url`/fetch): session-scoped per-host grants. Argus has no
  // network sandbox, so the risk is uniform MEDIUM ask; the grant key is the hostname so
  // an allow-for-session covers repeat fetches to the same domain.
  if (tax && tax.kind === 'network') {
    const url = String(input[tax.urlField] ?? '')
    let host = ''
    try {
      host = new URL(url).hostname
    } catch {
      host = ''
    }
    return {
      action: 'ask',
      risk: 'MEDIUM',
      grantKey: `net:${host}`,
      reason: `Network egress: ${url}`
    }
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

  // Non-MCP unknown tools: driver-declared fallback, else fail closed.
  if (ctx.taxonomy.fallback) return ctx.taxonomy.fallback(toolName)
  return {
    action: 'ask',
    risk: 'HIGH',
    grantKey: null,
    reason: `Unrecognized tool (fail-closed): ${toolName}`
  }
}
