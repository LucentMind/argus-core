import type { CaseDistillInput, CaseDistillOutput } from '../../../../shared/distill'
import type {
  Dossier,
  KnowledgeCandidate,
  PipelineStages,
  PreStageDrop,
  StageRecord,
  StageUsage
} from '../../../../shared/distillV3'
import type { HeadlessResult, HeadlessUsage } from '../../agent/driver'
import {
  DistillAgentRunError,
  type CaseDistillRun,
  type DistillAgentRunMeta,
  type HeadlessAgentRunnerFn
} from '../caseDistiller'
import { DistillParseError } from '../contract'
import { createDistillMcpServer } from '../mcp'
import { DISTILL_ALLOWED_TOOLS, DISTILL_MAX_ITERATIONS } from '../worldTools'
import { buildDossierPrompt, parseDossier, pruneUnknownCites } from './dossier'
import { buildSummaryPrompt, parseSummary } from './summary'
import { buildCandidatesPrompt, parseCandidates } from './candidates'
import { vetoCandidates } from './veto'
import {
  buildMaterializePrompt,
  parseMaterializeOutput,
  materializeToProposal
} from './materialize'
import { validateMaterialized } from './validators'
import { stagePromptHash } from './promptHash'

export interface PipelineRunners {
  /** stage 1 — agentic, tools over the frozen world */
  agent: HeadlessAgentRunnerFn
  /** stages 2a / 2b / 3 — plain headless prompt */
  oneShot: (prompt: string, opts?: { signal?: AbortSignal }) => Promise<HeadlessResult>
}

export const MATERIALIZE_CONCURRENCY = 3

const addUsage = (a: StageUsage | undefined, b: StageUsage | undefined): StageUsage | undefined => {
  if (!a) return b
  if (!b) return a
  const sum = (x?: number, y?: number): number | undefined =>
    x === undefined && y === undefined ? undefined : (x ?? 0) + (y ?? 0)
  return {
    inputTokens: sum(a.inputTokens, b.inputTokens),
    outputTokens: sum(a.outputTokens, b.outputTokens),
    costUsd: sum(a.costUsd, b.costUsd),
    durationMs: sum(a.durationMs, b.durationMs)
  }
}

/** `StageUsage.durationMs` is optional, `HeadlessUsage.durationMs` is not — the aggregate always
 *  carries one when any stage reported one, and 0 is the honest value when none did. */
const asHeadlessUsage = (u: StageUsage | undefined): HeadlessUsage | undefined =>
  u ? { ...u, durationMs: u.durationMs ?? 0 } : undefined

async function mapLimit<T, R>(
  items: T[],
  limit: number,
  fn: (t: T, i: number) => Promise<R>,
  signal?: AbortSignal
): Promise<(R | undefined)[]> {
  const out: (R | undefined)[] = new Array(items.length).fill(undefined)
  let next = 0
  // A limit < 1 would spawn zero workers and silently drop every item — clamp, never no-op.
  const width = Math.min(Math.max(1, Math.floor(limit)), items.length)
  const workers = Array.from({ length: width }, async () => {
    while (next < items.length) {
      // A cancel between items must not start another call. The in-flight one rethrows on its
      // own (oneShotStage), so the usual cancel path is a rejection; this only stops the queue
      // from draining when the abort lands in the gap between two calls, leaving the unstarted
      // slots as holes the caller skips.
      if (signal?.aborted) return
      const i = next++
      out[i] = await fn(items[i], i)
    }
  })
  await Promise.all(workers)
  return out
}

/** One tool-less stage call → its StageRecord + parsed value (or an error recorded on the record). */
async function oneShotStage<T>(
  runners: PipelineRunners,
  stage: 'summary' | 'candidates' | 'materialize',
  prompt: string,
  parse: (text: string) => T,
  resolve: ((id: string) => string) | undefined,
  signal: AbortSignal | undefined
): Promise<{ record: StageRecord; value?: T }> {
  const record: StageRecord = {
    promptHash: stagePromptHash(stage, resolve),
    promptChars: prompt.length,
    rawOutput: ''
  }
  let res: HeadlessResult
  try {
    res = await runners.oneShot(prompt, signal ? { signal } : undefined)
  } catch (e) {
    // A cancelled run is not a stage failure — let it abort the whole pipeline.
    if (signal?.aborted) throw e
    record.error = e instanceof Error ? e.message : String(e)
    return { record }
  }
  record.rawOutput = res.text
  record.usage = res.usage
  try {
    return { record, value: parse(res.text) }
  } catch (e) {
    record.error = e instanceof Error ? e.message : String(e)
    return { record }
  }
}

/**
 * v3 pipeline: dossier (agentic) → summary ‖ candidates → veto → materialize (parallel, ≤3)
 * → validators → CaseDistillOutput. Returns the same `CaseDistillRun` shape the queue stages,
 * plus `stages` and `preStageDropped`.
 *
 * Three exits, not two:
 *  1. a clean run RESOLVES with the full output;
 *  2. any failure that ends the run THROWS `DistillAgentRunError`, whose `agentMeta.stages`
 *     carries whatever stages completed (including the failing stage's own `error`);
 *  3. an abort usually rejects with the in-flight runner's own error — but a cancel that lands in
 *     the GAP between two materialize calls stops the queue instead, and the function RESOLVES
 *     with a PARTIAL run: the unstarted candidates are holes the post loop skips, so the output
 *     is missing proposals with nothing marking them missing. That result is not a valid run —
 *     it is the queue's `aborted` guard (runJob re-checks `ac.signal.aborted` before staging)
 *     that discards it, never this function.
 */
export async function runCaseDistillPipeline(
  input: CaseDistillInput,
  runners: PipelineRunners,
  resolve?: (id: string) => string,
  signal?: AbortSignal,
  opts: { concurrency?: number } = {}
): Promise<CaseDistillRun> {
  const stages: PipelineStages = {}
  let usage: StageUsage | undefined
  let promptChars = 0

  // ── stage 1: dossier ─────────────────────────────────────────────────────────────────────
  const dossierPrompt = buildDossierPrompt(input, resolve)
  promptChars += dossierPrompt.length
  const server = createDistillMcpServer(input.world ?? { sessions: [] })
  const res = await runners.agent(dossierPrompt, {
    mcpServer: server,
    // Two layers, one name. The SDK-level `allowedTools` option is pinned to [] INSIDE the driver
    // (a bare entry there auto-approves the tool before canUseTool is ever consulted); THIS list
    // is the canUseTool whitelist the driver consults — passing [] would deny every world tool.
    allowedTools: DISTILL_ALLOWED_TOOLS,
    maxIterations: DISTILL_MAX_ITERATIONS,
    ...(signal ? { signal } : {})
  })
  const dossierRecord: StageRecord = {
    promptHash: stagePromptHash('dossier', resolve),
    promptChars: dossierPrompt.length,
    rawOutput: res.text,
    usage: res.usage
  }
  stages.dossier = dossierRecord
  usage = addUsage(usage, res.usage)
  const meta = (): DistillAgentRunMeta => ({
    usage: asHeadlessUsage(usage),
    turnCount: res.turnCount,
    toolCallCount: res.toolCallCount,
    trajectory: res.trajectory,
    promptChars,
    stages
  })
  if (res.capHit) {
    dossierRecord.error = `budget exhausted (${res.capHit}${res.capSubtype ? `/${res.capSubtype}` : ''})`
    throw new DistillAgentRunError(
      `${dossierRecord.error} before a dossier`,
      res.text,
      meta(),
      res.capHit,
      res.capSubtype
    )
  }
  let dossier: Dossier
  try {
    const parsed = parseDossier(res.text)
    // parseDossier drops items with NO cites; pruneUnknownCites drops the ones whose cites are
    // well-formed but name nothing in the input (an invented finding id, a turn past the end of a
    // session). Both are "the dossier said this but could not back it" — merged under one key.
    const pruned = pruneUnknownCites(parsed.dossier, input)
    dossier = pruned.dossier
    const uncited = { ...parsed.uncitedDropped }
    for (const [k, n] of Object.entries(pruned.dropped)) uncited[k] = (uncited[k] ?? 0) + n
    if (Object.keys(uncited).length) stages.dossierUncitedDropped = uncited
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e)
    dossierRecord.error = msg
    if (e instanceof DistillParseError)
      throw new DistillAgentRunError(`dossier: ${msg}`, res.text, meta())
    throw e
  }

  // Everything past the dossier is wrapped: only stage PARSE failures come back as recorded
  // stage errors, and anything else thrown here (a prompt builder, a validator, a helper) would
  // otherwise escape as a bare Error — which the queue then persists WITHOUT `stages_json`,
  // losing the only column that says how far the run actually got. An abort is rethrown
  // untouched: the queue must read a cancelled run as cancelled, never as a failure.
  try {
    // ── stage 2a ‖ 2b ────────────────────────────────────────────────────────────────────────
    const summaryPrompt = buildSummaryPrompt(input, dossier, resolve)
    const candidatesPrompt = buildCandidatesPrompt(input, dossier, resolve)
    promptChars += summaryPrompt.length + candidatesPrompt.length
    const [sum, cand] = await Promise.all([
      oneShotStage(runners, 'summary', summaryPrompt, parseSummary, resolve, signal),
      oneShotStage(runners, 'candidates', candidatesPrompt, parseCandidates, resolve, signal)
    ])
    stages.summary = sum.record
    stages.candidates = cand.record
    usage = addUsage(addUsage(usage, sum.record.usage), cand.record.usage)
    if (cand.value === undefined) {
      throw new DistillAgentRunError(
        `candidates: ${cand.record.error ?? 'no output'}`,
        cand.record.rawOutput,
        meta()
      )
    }
    if (cand.value.malformedDropped) stages.candidatesMalformedDropped = cand.value.malformedDropped

    // ── veto ─────────────────────────────────────────────────────────────────────────────────
    const { kept, dropped } = vetoCandidates(cand.value.candidates, dossier, input)
    const preStageDropped: PreStageDrop[] = [...dropped]

    // ── stage 3: materialize (parallel) → validators ─────────────────────────────────────────
    const matRecords: NonNullable<PipelineStages['materialize']> = []
    // Attached NOW (live reference), not after the loop: a throw from materializeToProposal /
    // validateMaterialized inside the post loop must still surface every record collected so far
    // through meta() → agentMeta.stages.
    stages.materialize = matRecords
    const proposals: NonNullable<CaseDistillOutput['proposals']> = []
    // NaN / 0 / negative must fall back to the default rather than clamp to a 1-wide run.
    const width =
      opts.concurrency !== undefined && Number.isFinite(opts.concurrency) && opts.concurrency >= 1
        ? Math.floor(opts.concurrency)
        : MATERIALIZE_CONCURRENCY
    const results = await mapLimit(
      kept,
      width,
      async (c: KnowledgeCandidate) => {
        const prompt = buildMaterializePrompt(input, dossier, c, resolve)
        const r = await oneShotStage(
          runners,
          'materialize',
          prompt,
          (t) => parseMaterializeOutput(t, c.type),
          resolve,
          signal
        )
        // Folded here, not in the post loop: a cancel mid-materialize still counts every call that
        // actually completed, instead of dropping the cost of the whole stage on the floor.
        promptChars += prompt.length
        usage = addUsage(usage, r.record.usage)
        return { c, r }
      },
      signal
    )
    for (const item of results) {
      // Holes = slots a cancel stopped before they started (see mapLimit).
      if (!item) continue
      const { c, r } = item
      const rec = { ...r.record, type: c.type, target: c.target }
      matRecords.push(rec)
      if (r.value === undefined) {
        preStageDropped.push({
          type: c.type,
          target: c.target,
          title: c.title,
          reason: 'materialize-error'
        })
        continue
      }
      const m = materializeToProposal(input, dossier, c, r.value)
      if (!m.ok) {
        rec.error = m.error
        preStageDropped.push({
          type: c.type,
          target: c.target,
          title: c.title,
          reason: 'patch-error'
        })
        continue
      }
      const v = validateMaterialized(
        {
          type: c.type,
          target: c.target,
          content: m.proposal.content,
          basis: m.proposal.basis ?? '',
          original: m.original,
          wholeFileUsed: m.wholeFileUsed
        },
        { slug: input.caseMeta.slug, jiraKey: input.caseMeta.jiraKey }
      )
      if (!v.ok) {
        rec.error = `validator: ${v.reason}`
        preStageDropped.push({ type: c.type, target: c.target, title: c.title, reason: v.reason })
        continue
      }
      // A flag is not a failure — it rides its own channel so a KEPT proposal is never persisted
      // with an `error` a reader would take for "this stage produced nothing".
      if (v.flags.length) rec.flags = v.flags
      proposals.push(m.proposal)
    }

    const output: CaseDistillOutput = {
      ...(sum.value ? { summary: sum.value } : {}),
      proposals
    }
    return {
      raw: '```json\n' + JSON.stringify(output) + '\n```',
      output,
      promptChars,
      usage: asHeadlessUsage(usage),
      turnCount: res.turnCount,
      toolCallCount: res.toolCallCount,
      trajectory: res.trajectory,
      stages,
      preStageDropped
    }
  } catch (e) {
    if (e instanceof DistillAgentRunError || signal?.aborted) throw e
    throw new DistillAgentRunError(e instanceof Error ? e.message : String(e), '', meta())
  }
}
