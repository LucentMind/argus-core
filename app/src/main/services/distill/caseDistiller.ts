import type {
  CaseDistillInput,
  CaseDistillOutput,
  DistillProgressUpdate
} from '../../../shared/distill'
import { buildCaseDistillPrompt, parseCaseDistillOutput, DistillParseError } from './contract'
import type {
  HeadlessAgentResult,
  HeadlessResult,
  HeadlessUsage,
  TrajectoryEntry
} from '../agent/driver'
import { createDistillMcpServer, toolCallSummary } from './mcp'
import { DISTILL_ALLOWED_TOOLS, DISTILL_MAX_ITERATIONS } from './worldTools'
import type { PipelineStages, PreStageDrop } from '../../../shared/distillV3'

export interface CaseDistillRun {
  raw: string
  output: CaseDistillOutput
  /** Absent from the v1 one-shot path (`runCaseDistill`); always present from the agentic
   *  path (`runCaseDistillAgent`) — the prompt is always built there, so the length is free. */
  promptChars?: number
  usage?: HeadlessUsage
  turnCount?: number
  toolCallCount?: number
  trajectory?: TrajectoryEntry[]
  /** v3 only: per-stage records + drops recorded before staging (veto/validators). */
  stages?: PipelineStages
  preStageDropped?: PreStageDrop[]
}

/**
 * v1 distiller: one tool-less headless prompt. Deliberately provider-blind — it receives a
 * runner and owns only the prompt and the parse. Resolving WHICH provider runs it belongs to
 * agent/headless.ts; conflating the two is what let the active chat instance's "auto" model
 * reach the Claude SDK.
 */
export async function runCaseDistill(
  input: CaseDistillInput,
  // Widened for Task 10 (usage reporting); usage is dropped here for now (temporarily,
  // per plan) — `raw` stays the text so the parse/stage pipeline below is unaffected.
  run: (prompt: string, opts?: { signal?: AbortSignal }) => Promise<HeadlessResult>,
  resolve?: (id: string) => string,
  signal?: AbortSignal
): Promise<CaseDistillRun> {
  const result = await run(buildCaseDistillPrompt(input, resolve), signal ? { signal } : undefined)
  const raw = result.text
  return { raw, output: parseCaseDistillOutput(raw) }
}

/** Metadata captured off an agentic run so it can still be persisted whenever the run is
 *  thrown away as a failure — a `capHit` run AND an ordinary clean-but-unparseable run both
 *  spent real tokens/turns worth recording (see `DistillAgentRunError`). */
export interface DistillAgentRunMeta {
  usage?: HeadlessUsage
  turnCount?: number
  toolCallCount?: number
  trajectory?: TrajectoryEntry[]
  promptChars?: number
  /** v3 only: whatever stages had completed when the run failed. */
  stages?: PipelineStages
}

/**
 * Thrown by `runCaseDistillAgent` for EVERY way an agentic run fails to produce usable output —
 * both a `capHit` cutoff (Task 11's reviewer/owner-confirmed handoff decision: a budget-
 * exhausted run's `text` can be stale mid-run content and must NEVER be parsed as a success)
 * and an ordinary clean run whose final text just doesn't parse (§8's "record cost on every
 * job" applies identically here — a clean run that burned tokens and still got the JSON wrong
 * is, if anything, the MORE common failure mode, not a corner case). Extending
 * `DistillParseError` (rather than a sibling type) means `queue.ts` only needs ONE extra
 * `instanceof` branch, checked before the generic `DistillParseError` branch (this is a
 * subclass): every agentic failure — capHit or plain parse failure — carries `agentMeta` so the
 * queue can persist usage/turn/tool/trajectory columns on the FAILED row, not just a done one.
 * `capHit`/`capSubtype` ride along too, for the message text and for callers that want to tell
 * a budget cutoff apart from a parse failure without string-matching `message`.
 *
 * This is the seam this task picked over a `{ok:false, ...}` result-object return:
 * throwing keeps `runCaseDistillAgent`'s success return type unchanged (`CaseDistillRun`, no
 * `ok` flag to check everywhere it's consumed — the eval harness's `replay.ts` included) and
 * keeps the "parse errors are exceptions" contract `contract.ts`/`queue.ts` already share; the
 * metadata rides along on the error object instead of forcing a second, parallel return
 * channel.
 */
export class DistillAgentRunError extends DistillParseError {
  constructor(
    message: string,
    raw: string,
    public agentMeta?: DistillAgentRunMeta,
    public capHit?: 'iterations' | 'timeout',
    public capSubtype?: string
  ) {
    super(message, raw)
  }
}

/** Per-call agentic-runner shape `runCaseDistillAgent` depends on — matches
 *  `createHeadlessAgentRunner`'s return type (agent/headlessAgent.ts) structurally, without
 *  importing that module (this stays provider-blind, same as `runCaseDistill` above). */
export type HeadlessAgentRunnerFn = (
  prompt: string,
  opts: { mcpServer: unknown; allowedTools: string[]; maxIterations: number; signal?: AbortSignal }
) => Promise<HeadlessAgentResult>

/**
 * v2 distiller: the agentic, tool-using headless run over a frozen `DistillWorld` snapshot.
 * Same provider-blind split as `runCaseDistill` — owns the prompt, the MCP server, and the
 * parse; WHICH provider runs it is `createHeadlessAgentRunner`'s job.
 *
 * Every way this can fail to produce usable output throws `DistillAgentRunError` carrying
 * `agentMeta` (usage/turn/tool/trajectory), never a bare `DistillParseError` with no metadata:
 * - A `capHit` result (the driver's budget — iterations or wall-clock timeout — ran out before
 *   a clean `result: success`) is NEVER handed to `parseCaseDistillOutput`: its `text` may be
 *   stale mid-run content, not a final answer.
 * - A clean run (no `capHit`) whose `text` still doesn't parse is caught and rethrown with the
 *   same `agentMeta` attached — this is the MORE likely failure mode of the two (an agent that
 *   ran to completion but got the closing JSON wrong), so it must record cost too, not just the
 *   capHit corner case.
 */
export async function runCaseDistillAgent(
  input: CaseDistillInput,
  runAgent: HeadlessAgentRunnerFn,
  resolve?: (id: string) => string,
  signal?: AbortSignal,
  onProgress?: (u: DistillProgressUpdate) => void
): Promise<CaseDistillRun> {
  const prompt = buildCaseDistillPrompt(input, resolve)
  const promptChars = prompt.length
  let toolCalls = 0
  onProgress?.({ phase: 'agent', toolCalls: 0 })
  const server = createDistillMcpServer(input.world ?? { sessions: [] }, undefined, {
    onToolCall: (name, args) => {
      toolCalls++
      onProgress?.({ phase: 'agent', detail: toolCallSummary(name, args), toolCalls })
    }
  })
  const res = await runAgent(prompt, {
    mcpServer: server,
    allowedTools: DISTILL_ALLOWED_TOOLS,
    maxIterations: DISTILL_MAX_ITERATIONS,
    ...(signal ? { signal } : {})
  })
  const agentMeta: DistillAgentRunMeta = {
    usage: res.usage,
    turnCount: res.turnCount,
    toolCallCount: res.toolCallCount,
    trajectory: res.trajectory,
    promptChars
  }
  if (res.capHit) {
    const subtype = res.capSubtype ? `/${res.capSubtype}` : ''
    throw new DistillAgentRunError(
      `budget exhausted (${res.capHit}${subtype}) before a final answer`,
      res.text,
      agentMeta,
      res.capHit,
      res.capSubtype
    )
  }
  let output: CaseDistillOutput
  try {
    output = parseCaseDistillOutput(res.text)
  } catch (err) {
    // A clean run whose text just doesn't parse — the common case, not a corner case. Rethrow
    // carrying the same agentMeta the capHit branch above attaches, so queue.ts's single
    // metadata-persisting catch branch (keyed on `instanceof DistillAgentRunError`) handles
    // both without the caller needing to tell them apart.
    if (err instanceof DistillParseError) {
      throw new DistillAgentRunError(err.message, err.raw, agentMeta)
    }
    throw err
  }
  return {
    raw: res.text,
    output,
    promptChars,
    usage: res.usage,
    turnCount: res.turnCount,
    toolCallCount: res.toolCallCount,
    trajectory: res.trajectory
  }
}
