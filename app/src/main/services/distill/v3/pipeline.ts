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
import { DISTILL_MAX_ITERATIONS } from '../worldTools'
import { buildDossierPrompt, parseDossier } from './dossier'
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
  fn: (t: T, i: number) => Promise<R>
): Promise<R[]> {
  const out: R[] = new Array(items.length)
  let next = 0
  // A limit < 1 would spawn zero workers and silently drop every item — clamp, never no-op.
  const width = Math.min(Math.max(1, Math.floor(limit)), items.length)
  const workers = Array.from({ length: width }, async () => {
    while (next < items.length) {
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
 * plus `stages` and `preStageDropped`. Every failure that ends the run throws
 * `DistillAgentRunError` whose `agentMeta.stages` carries whatever stages completed.
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
    // v2 lesson: a bare allowedTools entry auto-approves BEFORE canUseTool; the whitelist lives
    // in the runner's canUseTool. This must stay [].
    allowedTools: [],
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
    dossier = parsed.dossier
    if (Object.keys(parsed.uncitedDropped).length)
      stages.dossierUncitedDropped = parsed.uncitedDropped
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e)
    dossierRecord.error = msg
    if (e instanceof DistillParseError)
      throw new DistillAgentRunError(`dossier: ${msg}`, res.text, meta())
    throw e
  }

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

  // ── veto ─────────────────────────────────────────────────────────────────────────────────
  const { kept, dropped } = vetoCandidates(cand.value, dossier, input)
  const preStageDropped: PreStageDrop[] = [...dropped]

  // ── stage 3: materialize (parallel) → validators ─────────────────────────────────────────
  const matRecords: NonNullable<PipelineStages['materialize']> = []
  const proposals: NonNullable<CaseDistillOutput['proposals']> = []
  const results = await mapLimit(
    kept,
    opts.concurrency ?? MATERIALIZE_CONCURRENCY,
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
      return { c, prompt, r }
    }
  )
  for (const { c, prompt, r } of results) {
    promptChars += prompt.length
    usage = addUsage(usage, r.record.usage)
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
    if (v.flags.length) rec.error = `flags: ${v.flags.join(',')}`
    proposals.push(m.proposal)
  }
  stages.materialize = matRecords

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
}
