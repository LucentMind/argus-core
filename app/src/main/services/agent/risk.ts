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
  // KNOWN, recorded rather than fixed. On Windows the agent's shell is git-bash, whose absolute
  // paths are spelled `/c/Users/…`; `~/…` is the same story on every platform. `path.resolve` in
  // `withinAny` reads that leading `/` as "root of the current drive" and turns it into
  // `C:\c\Users\…` (and leaves `~` as a literal directory name), so a path INSIDE the case
  // directory written either way sits outside every sandbox root. This function is BOTH the `cd`
  // check and the fs-read/fs-write sandbox check below, so what gets denied is `cd /c/<caseDir>`
  // AND every fs-tool path field spelled that way — `read_file "/c/<caseDir>/evidence/x.log"` is
  // refused just as flatly.
  // This is the mirror image of the skill-asset gate defect fixed in `skillAssetGate.ts`
  // (`msysAltPathFor`, `tildeAltPath`) — but it errs the conservative way (a false deny, never a
  // false allow), and it predates that work, so widening MSYS/tilde handling to all FS
  // classification here is left for a change that can cover every path field at once.
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

/**
 * The session grant key for a segment that runs a skill script.
 *
 * TWO digests, not one. The content hash kills the grant the instant the bytes change —
 * including mid-session after a HiveMind pull. The segment digest scopes it to this exact
 * command line, so approving `sh collect.sh` grants nothing to `sh collect.sh --purge /`,
 * `sh collect.sh > ~/.bashrc`, or `sh collect.sh $(curl evil)`. That matters more than it looks:
 * the asset verdict REPLACES the ordinary classification for its segment, so whatever the
 * classifier would have said about those extra tokens never runs either.
 *
 * A key at all, rather than `null`: re-prompting on every iteration of a loop that calls the
 * same script ten times trains exactly the click-through reflex this gate exists to prevent.
 * An identical command re-issued still rides the grant; anything else re-prompts.
 *
 * Two callers narrow it further and neither is optional. `classifySegment` refuses a key when
 * the segment's ORDINARY verdict was a grantless ask, and `classifyToolCall` refuses one for
 * any command with more than one meaningful segment — see both for why.
 *
 * DEVIATION from the plan's Global Constraints, which state the format as
 * `skill-asset:${hash.slice(0, 16)}` (the script alone). A human decided to narrow it after
 * final review found the hash-only key covered arbitrary arguments and redirections.
 */
function assetGrantKey(asset: SkillAssetContext): string {
  return `skill-asset:${asset.hash.slice(0, 16)}:${asset.segmentKey.slice(0, 16)}`
}

/**
 * Classify one segment, with the skill-asset gate layered over the ordinary classification.
 *
 * Order matters, and it is deny-first. The gate scans EVERY token in the segment, so a segment
 * that both leaves the sandbox and mentions a skill script — `cd /outside <skill script>` — used
 * to come back as a HIGH ask because the gate returned before the `cd` deny was ever reached.
 * More generally: any deny rule added to `classifyPlainSegment` below would be silently
 * unreachable for asset-bearing segments. A gate that can WEAKEN an existing deny is pointed the
 * wrong way, so the base classification runs first and a deny wins outright.
 *
 * Running the base path always is free — it is string-only, no filesystem, no database — and it
 * runs before `ctx.skillAsset`, so a denied segment does not pay for the gate's syscalls at all.
 *
 * With `baseWasGrantless` below, the gate can only ever STRENGTHEN a verdict, on all three
 * dimensions: a deny stays a deny, HIGH is the top risk, and a base ask the classifier
 * deliberately refused to make grantable stays ungrantable. That last one is not decoration —
 * `rm -rf <skill script>` and `gh api -X POST … --input <skill script>` both name an asset, and
 * before the fix the gate handed each of them a session-grantable key that the classifier had
 * explicitly set to `null`, turning a never-grant verdict into a grantable one.
 */
function classifySegment(segment: string, ctx: RiskContext): RiskVerdict {
  const base = classifyPlainSegment(segment, ctx)
  if (base.action === 'deny') return base
  // The gate sits above the program-name dispatch: what matters is the FILE a segment executes,
  // not whether the program is `bash`, `sh`, `python`, or the script itself. A gate, not a
  // sandbox (spec §7.4) — see `skillAssetContextForSegment` for the full list of what it cannot
  // see (command substitution, stdin-fed interpreters, `sh -c "…"`, paths containing a space);
  // all of those fall back to the ordinary classification computed above.
  const asset = ctx.skillAsset?.(segment)
  if (!asset) return base
  const baseWasGrantless = base.action === 'ask' && base.grantKey === null
  return {
    action: 'ask',
    risk: 'HIGH',
    grantKey: baseWasGrantless ? null : assetGrantKey(asset),
    // The asset half leads: the card's copy comes from `assetContext`, not from here, so this
    // only shapes the audit line — and an audit line reading only "runs a reviewed script" for
    // a `gh api -X POST` mislabels a remote mutation. Keep both facts, script first.
    reason: base.action === 'ask' ? `${assetReason(asset)} — ${base.reason}` : assetReason(asset),
    assetContext: asset
  }
}

function classifyPlainSegment(segment: string, ctx: RiskContext): RiskVerdict {
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
    // Empty segments do not count: a trailing `;` or `|` splits into two, and treating
    // `sh collect.sh;` as a chained command would strip the key off an ordinary one-command
    // invocation — killing the loop ergonomics `assetGrantKey` exists for, for a stray separator.
    const meaningful = segments.filter((s) => s.trim() !== '')
    let worst: RiskVerdict = { action: 'allow', risk: 'LOW' }
    // Every DISTINCT script the command runs, in order — used only to word the reason below.
    const assets: SkillAssetContext[] = []
    for (const seg of segments) {
      const v = classifySegment(seg, ctx)
      if (v.action === 'deny') return v
      if (
        v.action === 'ask' &&
        v.assetContext &&
        !assets.some((a) => a.hash === v.assetContext!.hash)
      )
        assets.push(v.assetContext)
      if (isWorse(v, worst)) worst = v
    }
    // The grant key is computed per SEGMENT but applied to the WHOLE command, so a chained
    // command must not carry one at all. `isWorse` prefers an asset ask over a plain ask of
    // equal risk (so the card always has a script in it), which means the winning verdict is
    // the FIRST asset segment's — identical, key included, to what a bare `sh collect.sh`
    // produces. Without this block, one "approve for session" on the benign form silently
    // auto-allows `sh collect.sh && rm -rf ~`, `&& git push`, `&& sh collect.sh --purge /`,
    // `| tee ~/.bashrc` — with no card, and an audit line naming only the script. Against main
    // that is a REGRESSION: every HIGH ask there carried a null key, so the `rm -rf` always
    // asked; this gate introduced the first keyed HIGH ask and let it beat the others.
    //
    // Deliberately broader than "more than one distinct script", which it subsumes (two assets
    // need two segments — `skillAssetContextForSegment` takes at most one per segment). Single
    // segments, the loop case the key exists for, are untouched.
    if (worst.action === 'ask' && worst.assetContext && meaningful.length > 1) {
      // `grantKey: null` is the load-bearing half — it is what removes the silent-execution
      // path. The card still shows only the FIRST script's bytes (`assetContext` is unchanged);
      // with no grant the reviewer now always gets a card, and its `argsPreview` is the whole
      // command line, so the others are at least named. Showing every script's bytes on one
      // card is a deferred design change (final review round 2, Minor), not a hole.
      return {
        ...worst,
        grantKey: null,
        reason:
          assets.length > 1
            ? `${assets.length} different skill scripts in one command (${assets
                .map((a) => `${a.skill}/${a.relPath}`)
                .join(', ')}) — only the first is shown; no session grant`
            : `${worst.reason} — chained with other commands; no session grant`
      }
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
