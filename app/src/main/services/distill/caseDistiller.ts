import type { CaseDistillInput, CaseDistillOutput } from '../../../shared/distill'
import { buildCaseDistillPrompt, parseCaseDistillOutput, DistillParseError } from './contract'
import type {
  HeadlessAgentResult,
  HeadlessResult,
  HeadlessUsage,
  TrajectoryEntry
} from '../agent/driver'
import { createDistillMcpServer } from './mcp'
import { DISTILL_ALLOWED_TOOLS, DISTILL_MAX_ITERATIONS } from './worldTools'

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

/** Metadata captured off an agentic run so it can still be persisted when the run is thrown
 *  away as a parse failure (a `capHit` run in particular — see `DistillCapHitError`). */
export interface DistillAgentRunMeta {
  usage?: HeadlessUsage
  turnCount?: number
  toolCallCount?: number
  trajectory?: TrajectoryEntry[]
  promptChars?: number
}

/**
 * Thrown instead of ever calling `parseCaseDistillOutput` when the driver reports `capHit` —
 * per Task 11's reviewer/owner-confirmed handoff decision, a budget-exhausted run's `text` can
 * be stale mid-run content (e.g. a fenced block from an earlier, superseded turn) and must
 * NEVER be parsed as a success. Extending `DistillParseError` (rather than a sibling type)
 * means `queue.ts`'s existing `catch (err) { ... instanceof DistillParseError }` branch keeps
 * working unmodified for the "generic parse failure" case — this class only adds the extra
 * agent-run metadata queue.ts needs to persist the usage/trajectory columns on a FAILED job.
 * That's the seam this task picked over a `{ok:false, ...}` result-object return: throwing
 * keeps `runCaseDistillAgent`'s success return type unchanged (`CaseDistillRun`, no `ok` flag
 * to check everywhere it's consumed — the eval harness's `replay.ts` included) and keeps the
 * "parse errors are exceptions" contract `contract.ts`/`queue.ts` already share; the metadata
 * rides along on the error object instead of forcing a second, parallel return channel.
 */
export class DistillCapHitError extends DistillParseError {
  constructor(
    message: string,
    raw: string,
    public agentMeta?: DistillAgentRunMeta
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
 * A `capHit` result (the driver's budget — iterations or wall-clock timeout — ran out before a
 * clean `result: success`) is NEVER handed to `parseCaseDistillOutput`: its `text` may be stale
 * mid-run content, not a final answer. Throw `DistillCapHitError` instead, carrying the raw
 * text and whatever usage/trajectory the run collected before the cutoff, so the caller can
 * record state='failed' with `raw_output` AND the cost columns preserved.
 */
export async function runCaseDistillAgent(
  input: CaseDistillInput,
  runAgent: HeadlessAgentRunnerFn,
  resolve?: (id: string) => string,
  signal?: AbortSignal
): Promise<CaseDistillRun> {
  const prompt = buildCaseDistillPrompt(input, resolve)
  const promptChars = prompt.length
  const server = createDistillMcpServer(input.world ?? { sessions: [] })
  const res = await runAgent(prompt, {
    mcpServer: server,
    allowedTools: DISTILL_ALLOWED_TOOLS,
    maxIterations: DISTILL_MAX_ITERATIONS,
    ...(signal ? { signal } : {})
  })
  if (res.capHit) {
    const subtype = res.capSubtype ? `/${res.capSubtype}` : ''
    throw new DistillCapHitError(
      `budget exhausted (${res.capHit}${subtype}) before a final answer`,
      res.text,
      {
        usage: res.usage,
        turnCount: res.turnCount,
        toolCallCount: res.toolCallCount,
        trajectory: res.trajectory,
        promptChars
      }
    )
  }
  return {
    raw: res.text,
    output: parseCaseDistillOutput(res.text),
    promptChars,
    usage: res.usage,
    turnCount: res.turnCount,
    toolCallCount: res.toolCallCount,
    trajectory: res.trajectory
  }
}
