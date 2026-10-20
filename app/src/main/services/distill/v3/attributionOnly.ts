import type { CaseDistillInput, DistillProgressUpdate } from '../../../../shared/distill'
import type { Dossier, PipelineStages, StageRecord, StageUsage } from '../../../../shared/distillV3'
import type { AttributionOutput } from '../../../../shared/attribution'
import type { HeadlessUsage, TrajectoryEntry } from '../../agent/driver'
import { DistillAgentRunError, type DistillAgentRunMeta } from '../caseDistiller'
import { DistillParseError } from '../contract'
import { createDistillMcpServer, toolCallSummary } from '../mcp'
import { DISTILL_ALLOWED_TOOLS, DISTILL_MAX_ITERATIONS } from '../worldTools'
import {
  buildDossierPrompt,
  parseDossier,
  pruneUnknownCites,
  DOSSIER_LITE_CONTRACT,
  DOSSIER_SECTIONS
} from './dossier'
import {
  buildAttributionPrompt,
  parseAttribution,
  pruneAttributionCites,
  completeVerdicts,
  ATTRIBUTION_CONTRACT,
  ATTRIBUTION_SECTIONS
} from './attribution'
import { stagePromptHash } from './promptHash'
import { addUsage, asHeadlessUsage, type PipelineRunners } from './pipeline'

/** Half the full dossier's budget: the lite contract skips the knowledge-candidate groundwork. */
export const DOSSIER_LITE_MAX_ITERATIONS = Math.ceil(DISTILL_MAX_ITERATIONS / 2)
const DOSSIER_CONTRACT_ID = 'headless.case-distill.dossier.contract'
const ATTRIBUTION_CONTRACT_ID = 'headless.case-distill.attribution.contract'

/** Resolver for the lite run: the dossier contract id answers with the lite contract; every other
 *  id goes to the caller's resolver, or to the static defaults when there is none. (The builders
 *  only consult a resolver when one is passed, so the no-resolver case must still answer every id
 *  they ask for.) */
function liteResolve(resolve?: (id: string) => string): (id: string) => string {
  return (id) => {
    if (id === DOSSIER_CONTRACT_ID) return DOSSIER_LITE_CONTRACT
    if (resolve) return resolve(id)
    if (id === ATTRIBUTION_CONTRACT_ID) return ATTRIBUTION_CONTRACT
    const m = /^headless\.case-distill\.(dossier|attribution)\.section\.(.+)$/.exec(id)
    const spec = m
      ? (m[1] === 'dossier' ? DOSSIER_SECTIONS : ATTRIBUTION_SECTIONS)[m[2]]
      : undefined
    if (spec) return spec.text
    throw new Error(`liteResolve: unknown prompt id ${id}`)
  }
}

export interface AttributionOnlyRun {
  stages: PipelineStages
  attribution?: AttributionOutput
  usage?: HeadlessUsage
  promptChars: number
  turnCount: number
  toolCallCount: number
  trajectory: TrajectoryEntry[]
}

/**
 * The escape-hatch run (spec §4.5): a lite dossier (agentic, half budget, no knowledge-candidate
 * groundwork) then ONLY the attribution stage — no summary, candidates or materialize, so it never
 * produces proposals. Same exits as the pipeline: a dossier failure THROWS `DistillAgentRunError`
 * carrying `agentMeta.stages`; an attribution-stage failure is recorded on `stages.attribution`
 * and the run RESOLVES without `attribution`. An empty inventory resolves with
 * `attributionSkipped: 'no-assets'` before any model call — there is nothing to grade, so the
 * dossier would be paid for and thrown away.
 */
export async function runAttributionOnly(
  input: CaseDistillInput,
  runners: PipelineRunners,
  resolve?: (id: string) => string,
  signal?: AbortSignal,
  opts: { onProgress?: (u: DistillProgressUpdate) => void } = {}
): Promise<AttributionOnlyRun> {
  const stages: PipelineStages = {}
  const assets = input.assets ?? []
  if (assets.length === 0) {
    stages.attributionSkipped = 'no-assets'
    return { stages, promptChars: 0, turnCount: 0, toolCallCount: 0, trajectory: [] }
  }
  const res = liteResolve(resolve)
  const report = (u: DistillProgressUpdate): void => opts.onProgress?.(u)

  // ── lite dossier ──────────────────────────────────────────────────────────────────────────
  const dossierPrompt = buildDossierPrompt(input, res)
  let promptChars = dossierPrompt.length
  let toolCalls = 0
  report({ phase: 'dossier', toolCalls: 0 })
  const server = createDistillMcpServer(input.world ?? { sessions: [] }, undefined, {
    onToolCall: (name, args) => {
      toolCalls++
      report({ phase: 'dossier', detail: toolCallSummary(name, args), toolCalls })
    }
  })
  const agent = await runners.agent(dossierPrompt, {
    mcpServer: server,
    // The canUseTool whitelist — see the same call in pipeline.ts for why this is not [].
    allowedTools: DISTILL_ALLOWED_TOOLS,
    maxIterations: DOSSIER_LITE_MAX_ITERATIONS,
    ...(signal ? { signal } : {})
  })
  const dossierRecord: StageRecord = {
    promptHash: stagePromptHash('dossier', res),
    promptChars: dossierPrompt.length,
    rawOutput: agent.text,
    usage: agent.usage
  }
  stages.dossier = dossierRecord
  let usage: StageUsage | undefined = agent.usage
  const meta = (): DistillAgentRunMeta => ({
    usage: asHeadlessUsage(usage),
    turnCount: agent.turnCount,
    toolCallCount: agent.toolCallCount,
    trajectory: agent.trajectory,
    promptChars,
    stages
  })
  if (agent.capHit) {
    dossierRecord.error = `budget exhausted (${agent.capHit}${agent.capSubtype ? `/${agent.capSubtype}` : ''})`
    throw new DistillAgentRunError(
      `${dossierRecord.error} before a dossier`,
      agent.text,
      meta(),
      agent.capHit,
      agent.capSubtype
    )
  }
  let dossier: Dossier
  try {
    const parsed = parseDossier(agent.text)
    const pruned = pruneUnknownCites(parsed.dossier, input)
    dossier = pruned.dossier
    const uncited = { ...parsed.uncitedDropped }
    for (const [k, n] of Object.entries(pruned.dropped)) uncited[k] = (uncited[k] ?? 0) + n
    if (Object.keys(uncited).length) stages.dossierUncitedDropped = uncited
    if (Object.keys(parsed.malformedDropped).length)
      stages.dossierMalformedDropped = parsed.malformedDropped
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e)
    dossierRecord.error = msg
    if (e instanceof DistillParseError)
      throw new DistillAgentRunError(`dossier: ${msg}`, agent.text, meta())
    throw e
  }

  // ── attribution ───────────────────────────────────────────────────────────────────────────
  // Non-fatal past this point, as in the pipeline: a prompt-build, call or parse failure is the
  // stage's own `error` and the run resolves without `attribution`. An abort is rethrown so the
  // queue reads a cancelled run as cancelled.
  // No phase of its own: the pipeline runs this stage inside 'summary+candidates', and a new
  // DistillPhase would need a label on every renderer surface that reads progress.
  report({ phase: 'summary+candidates' })
  const record: StageRecord = {
    promptHash: stagePromptHash('attribution', res),
    promptChars: 0,
    rawOutput: ''
  }
  stages.attribution = record
  let attribution: AttributionOutput | undefined
  try {
    const prompt = buildAttributionPrompt(input, dossier, res)
    record.promptChars = prompt.length
    promptChars += prompt.length
    const r = await runners.oneShot(prompt, signal ? { signal } : undefined)
    record.rawOutput = r.text
    record.usage = r.usage
    usage = addUsage(usage, r.usage)
    const pruned = completeVerdicts(
      pruneAttributionCites(parseAttribution(r.text, assets), input),
      assets
    )
    if (Object.keys(pruned.malformedDropped).length)
      stages.attributionMalformedDropped = pruned.malformedDropped
    if (Object.keys(pruned.unknownAssetDropped).length)
      stages.attributionUnknownAssetDropped = pruned.unknownAssetDropped
    if (pruned.uncitedDropped) stages.attributionUncitedDropped = pruned.uncitedDropped
    attribution = pruned
  } catch (e) {
    if (signal?.aborted) throw e
    record.error = e instanceof Error ? e.message : String(e)
  }
  return {
    stages,
    ...(attribution ? { attribution } : {}),
    usage: asHeadlessUsage(usage),
    promptChars,
    turnCount: agent.turnCount,
    toolCallCount: agent.toolCallCount,
    trajectory: agent.trajectory
  }
}
