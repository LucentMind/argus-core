// app/src/main/services/observability/distillTelemetry.ts
import { createHash } from 'node:crypto'
import type { JobDbRow } from '../distill/queue'
import type { PipelineStages, PreStageDrop, StageRecord } from '../../../shared/distillV3'
import type { ProposalType, RejectReason, RejectReasonTag } from '../../../shared/proposals'
import type {
  EventIntent,
  GenerationIntent,
  ObservationIntent,
  ScoreIntent,
  TraceRootIntent
} from './intent'

/** Stable per-job seed: one trace per distill job, re-derivable from the row id alone. */
export function distillJobSeed(jobId: number): string {
  return `argus-distill-job-${jobId}`
}

export interface DistillTelemetryCtx {
  installId: string
  appVersion: string
  judgeModel: () => string
  captureContent: boolean
}

const DIGEST_KIND = 'reject-digest'

function rootName(row: JobDbRow): string {
  if (row.kind === DIGEST_KIND) return 'distill:reject-digest'
  if (row.kind === 'attribution') return `distill:attribution ${row.case_slug}`
  return `distill ${row.case_slug}`
}

function defined(o: Record<string, unknown>): Record<string, unknown> {
  return Object.fromEntries(Object.entries(o).filter(([, v]) => v !== undefined && v !== null))
}

function parseJson<T>(s: string | null): T | null | 'corrupt' {
  if (s == null) return null
  try {
    return JSON.parse(s) as T
  } catch {
    return 'corrupt'
  }
}

const ERROR_MAX = 300

/** Parser exceptions can quote the raw model text (`JSON.parse` echoes the start of its input),
 *  so an error string is first-line-only, capped, and — with content capture off — has every
 *  quoted segment replaced. */
export function scrubError(msg: string, captureContent: boolean): string {
  let out = String(msg).split(/\r?\n/)[0].slice(0, ERROR_MAX)
  if (!captureContent) out = out.replace(/"[^"\n]*"/g, '"…"').replace(/'[^'\n]*'/g, '"…"')
  return out
}

function scrubbed(e: unknown, captureContent: boolean): string | undefined {
  return typeof e === 'string' && e ? scrubError(e, captureContent) : undefined
}

function stageFacts(r: StageRecord, captureContent: boolean): Record<string, unknown> {
  return defined({
    promptHash: r.promptHash,
    promptChars: r.promptChars,
    flags: r.flags,
    error: scrubbed(r.error, captureContent)
  })
}

function isObj(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null
}

/** Ordered stage list: dossier → (summary ‖ candidates ‖ attribution) → materialize[] (sequential). */
function orderedStages(s: PipelineStages): { key: string; rec: StageRecord; parallel: boolean }[] {
  const out: { key: string; rec: StageRecord; parallel: boolean }[] = []
  if (isObj(s.dossier)) out.push({ key: 'dossier', rec: s.dossier, parallel: false })
  for (const k of ['summary', 'candidates', 'attribution'] as const)
    if (isObj(s[k])) out.push({ key: k, rec: s[k]!, parallel: true })
  const mats: unknown[] = Array.isArray(s.materialize) ? s.materialize : []
  for (const m of mats.filter(isObj) as unknown as NonNullable<PipelineStages['materialize']>)
    out.push({ key: `materialize ${m.type} ${m.target}`, rec: m, parallel: false })
  return out
}

/** Walk back from finished_at: materialize entries last-to-first, then the parallel group (one
 *  shared end, each its own start), then dossier ending where the longest parallel stage starts.
 *  A missing duration counts as 0. Returns [start, end] per key. */
function reconstructTimes(
  stages: ReturnType<typeof orderedStages>,
  finishedMs: number
): Map<string, [number, number]> {
  const times = new Map<string, [number, number]>()
  let cursor = finishedMs
  const mats = stages.filter((s) => s.key.startsWith('materialize ')).reverse()
  for (const m of mats) {
    const d = m.rec.usage?.durationMs ?? 0
    times.set(m.key, [cursor - d, cursor])
    cursor -= d
  }
  const par = stages.filter((s) => s.parallel)
  const parEnd = cursor
  let longest = 0
  for (const p of par) {
    const d = p.rec.usage?.durationMs ?? 0
    times.set(p.key, [parEnd - d, parEnd])
    longest = Math.max(longest, d)
  }
  cursor = parEnd - longest
  const dossier = stages.find((s) => s.key === 'dossier')
  if (dossier) {
    const d = dossier.rec.usage?.durationMs ?? 0
    times.set('dossier', [cursor - d, cursor])
  }
  return times
}

function dropsByStage(drops: PreStageDrop[]): Record<string, Record<string, number>> {
  const out: Record<string, Record<string, number>> = {}
  for (const d of drops) {
    if (!isObj(d)) continue
    const stage = d.stage ?? 'unknown'
    ;(out[stage] ??= {})[d.reason] = (out[stage][d.reason] ?? 0) + 1
  }
  return out
}

export function jobIntents(row: JobDbRow, ctx: DistillTelemetryCtx): ObservationIntent[] {
  const seed = distillJobSeed(row.id)
  const out: ObservationIntent[] = []
  const snapshot = parseJson<{ caseDomain?: string; caseOutcome?: string }>(row.input_snapshot)
  const snap = snapshot && snapshot !== 'corrupt' ? snapshot : {}
  const stagesParsed = parseJson<PipelineStages>(row.stages_json)
  const stages: PipelineStages | null =
    stagesParsed && stagesParsed !== 'corrupt' ? stagesParsed : null
  const ordered = stages ? orderedStages(stages) : []

  const root: TraceRootIntent = {
    kind: 'trace-root',
    seed,
    name: rootName(row),
    caseSlug: row.case_slug,
    metadata: defined({
      jobId: row.id,
      kind: row.kind,
      pipeline: row.pipeline,
      state: row.state,
      dryRun: row.dry_run === 1,
      promptHash: row.prompt_hash,
      itemCount: row.item_count,
      costUsd: row.cost_usd,
      durationMs: row.duration_ms,
      turnCount: row.turn_count,
      toolCallCount: row.tool_call_count,
      promptChars: row.prompt_chars,
      error: scrubbed(row.error, ctx.captureContent),
      installId: ctx.installId,
      appVersion: ctx.appVersion,
      caseDomain: snap.caseDomain,
      caseOutcome: snap.caseOutcome,
      createdAt: row.created_at,
      finishedAt: row.finished_at,
      stages: ordered.length
        ? Object.fromEntries(ordered.map((s) => [s.key, stageFacts(s.rec, ctx.captureContent)]))
        : undefined
    })
  }
  out.push(root)

  let model: string
  try {
    model = ctx.judgeModel()
  } catch {
    model = 'unknown'
  }
  const finishedMs = row.finished_at ? Date.parse(row.finished_at) : Date.now()
  const times = reconstructTimes(ordered, finishedMs)
  for (const s of ordered) {
    const [startTime, endTime] = times.get(s.key)!
    const gen: GenerationIntent = {
      kind: 'generation',
      seed,
      name: `stage ${s.key}`,
      model,
      startTime,
      endTime,
      ...(s.rec.usage && (s.rec.usage.inputTokens != null || s.rec.usage.outputTokens != null)
        ? { usage: defined({ input: s.rec.usage.inputTokens, output: s.rec.usage.outputTokens }) }
        : {}),
      ...(s.rec.usage?.costUsd != null ? { costUsd: s.rec.usage.costUsd } : {}),
      ...(ctx.captureContent ? { output: s.rec.rawOutput } : {})
    }
    out.push(gen)
    const stageError = scrubbed(s.rec.error, ctx.captureContent)
    if (stageError) {
      out.push({
        kind: 'event',
        seed,
        name: `stage ${s.key} error`,
        level: 'ERROR',
        metadata: { message: stageError }
      })
    }
  }
  if (stagesParsed === 'corrupt') out.push({ kind: 'event', seed, name: 'stages unreadable' })
  if (stages?.attributionSkipped) {
    out.push({
      kind: 'event',
      seed,
      name: 'attribution skipped',
      metadata: { reason: stages.attributionSkipped }
    })
  }
  const drops = parseJson<PreStageDrop[]>(row.dropped_json)
  if (Array.isArray(drops) && drops.length > 0) {
    out.push({ kind: 'event', seed, name: 'drops', metadata: dropsByStage(drops) })
  }
  if (stages) {
    const counters = defined({
      dossierUncitedDropped: stages.dossierUncitedDropped,
      dossierMalformedDropped: stages.dossierMalformedDropped,
      candidatesMalformedDropped: stages.candidatesMalformedDropped,
      attributionMalformedDropped: stages.attributionMalformedDropped,
      attributionUnknownAssetDropped: stages.attributionUnknownAssetDropped,
      attributionUncitedDropped: stages.attributionUncitedDropped
    })
    if (Object.keys(counters).length > 0)
      out.push({
        kind: 'event',
        seed,
        name: 'parser drops',
        metadata: counters
      } satisfies EventIntent)
  }
  return out
}

export function proposalScoreId(installId: string, proposalFile: string): string {
  return createHash('sha256').update(`${installId}|${proposalFile}`).digest('hex').slice(0, 32)
}

export type ProposalOutcome = 'accepted' | 'edited' | 'rejected'

export function proposalOutcomeOf(
  edited: boolean,
  _reason: RejectReason | undefined,
  decision: 'accept' | 'reject'
): ProposalOutcome {
  if (decision === 'reject') return 'rejected'
  return edited ? 'edited' : 'accepted'
}

export interface ProposalDecision {
  file: string
  type: ProposalType
  target: string
  caseSlug: string
  jobId: number | null
  outcome: ProposalOutcome
  rejectReason?: RejectReasonTag
  rejectNote?: string
}

const OUTCOME_VALUE: Record<ProposalOutcome, number> = { accepted: 1, edited: 0.5, rejected: 0 }

export function proposalScoreIntent(
  p: ProposalDecision,
  seed: string,
  ctx: Pick<DistillTelemetryCtx, 'installId' | 'appVersion'>
): ScoreIntent {
  // Same rule `rejectProposal` applies to `reject_note`: first non-empty line, trimmed, 200 chars.
  const note = p.rejectNote
    ?.split(/\r?\n/)
    .map((l) => l.trim())
    .find((l) => l)
    ?.slice(0, 200)
  return {
    kind: 'score',
    seed,
    name: 'proposal.outcome',
    value: OUTCOME_VALUE[p.outcome],
    ...(note ? { comment: note } : {}),
    id: proposalScoreId(ctx.installId, p.file),
    metadata: {
      'argus.proposal.type': p.type,
      'argus.proposal.target': p.target,
      'argus.proposal.outcome': p.outcome,
      'argus.proposal.edited': p.outcome === 'edited',
      ...(p.rejectReason ? { 'argus.proposal.reject_reason': p.rejectReason } : {}),
      'argus.case.slug': p.caseSlug,
      'argus.job.id': p.jobId,
      'argus.install.id': ctx.installId,
      'argus.app.version': ctx.appVersion
    }
  }
}
