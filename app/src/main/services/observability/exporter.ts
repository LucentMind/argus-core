import { createHash } from 'node:crypto'
import type { AgentEvent } from '../../../shared/agent-events'
import type { FindingRow } from '../../../shared/observability'
import type { AssetAttributionEvent } from '../../../shared/attribution'
import { seedFor } from './intent'
import type { ObservationIntent, ScoreIntent } from './intent'
import { initialState, reduce, type ExporterState } from './reducer'
import type { ObservationSink } from './sink'

/** Deterministic 32-hex Langfuse score id for one asset's contribution to one case. */
export function attributionScoreId(e: AssetAttributionEvent): string {
  return createHash('sha256')
    .update(
      `${e['argus.install.id']}|${e['argus.case.slug']}|${e['argus.asset.kind']}|${e['argus.asset.name']}`
    )
    .digest('hex')
    .slice(0, 32)
}

/** Deterministic 32-hex score id for one finding's review: a re-review (or a toggle back and
 *  forth) upserts the same score instead of stacking a contradicting one per click. */
export function findingScoreId(installId: string, findingId: number): string {
  return createHash('sha256').update(`${installId}|finding|${findingId}`).digest('hex').slice(0, 32)
}

/**
 * Holds reducer state and forwards the resulting intents to a sink.
 *
 * Error policy is deliberately split: a throw from `reduce` is a logic bug and
 * is logged loudly without touching `lastError()`, so it is never reported as
 * a connector fault. A throw from `sink.emit` would be a network or config
 * condition and is recorded via `lastError()`.
 *
 * Note that path is largely inert: real sinks never throw synchronously — they swallow
 * failures into their own `lastError?()` — so this class's `lastError()` is not populated by a
 * real sink failure, and no caller reads it. Per-provider health rows instead merge each
 * provider's probe with the live sink's own `lastError?.()` (see `checkObservabilityProvider`).
 * `sink` and `opts` are readonly-public so the factory test can assert wiring without reaching
 * into privates.
 */
export class ObservationExporter {
  private state: ExporterState = initialState()
  private error: string | null = null

  constructor(
    readonly sink: ObservationSink,
    readonly opts: { captureContent: boolean; installId: string }
  ) {}

  handle(e: AgentEvent): void {
    let intents: ObservationIntent[]
    try {
      const [next, produced] = reduce(this.state, e, this.opts)
      this.state = next
      intents = produced
    } catch (err) {
      // Logic bug in the reducer — not a connector fault. Do not set this.error.
      console.error('[observability] reducer failed on', e.type, err)
      return
    }
    this.push(intents)
  }

  /**
   * One `finding_accepted` score per finding (spec 2026-10-25 §4.7): 1 for accepted, 0 for a
   * human reject or an agent retraction. Pending emits nothing — with a deterministic id a reset
   * to pending leaves the last 1/0 in the sink until the next review upserts it, which is fine
   * because the dataset reads the local table, not the sink. The comment is content and is
   * gated on `captureContent`; the metadata is the label the eval dataset trains on.
   */
  scoreFinding(row: FindingRow | null, ctx: { caseSlug?: string } = {}): void {
    if (!row || row.sessionId == null || row.reviewState === 'pending') return
    const comment = row.reviewActor === 'agent' ? row.reviewReason : row.rejectNote
    this.push([
      {
        kind: 'score',
        seed: seedFor(this.opts.installId, row.sessionId),
        id: findingScoreId(this.opts.installId, row.id),
        name: 'finding_accepted',
        value: row.reviewState === 'accepted' ? 1 : 0,
        metadata: {
          findingId: row.id,
          ...(ctx.caseSlug ? { caseSlug: ctx.caseSlug } : {}),
          mode: row.mode,
          role: row.role,
          actor: row.reviewActor,
          tag: row.rejectTag,
          installId: this.opts.installId
        },
        ...(this.opts.captureContent && comment ? { comment } : {})
      }
    ])
  }

  /**
   * One `asset.contribution` score per judged event. Silent events (null score) are not
   * scored; the OTel-GenAI-shaped attribute bag rides along as score metadata, minus the
   * three keys the score itself already carries (name / value / label).
   */
  scoreAttributions(sessionId: number, events: AssetAttributionEvent[]): void {
    const intents: ObservationIntent[] = []
    for (const e of events) {
      const value = e['gen_ai.evaluation.score.value']
      if (value === null) continue
      const {
        'gen_ai.evaluation.name': _name,
        'gen_ai.evaluation.score.value': _value,
        'gen_ai.evaluation.score.label': _label,
        ...metadata
      } = e
      void _name
      void _value
      void _label
      intents.push({
        kind: 'score',
        seed: seedFor(this.opts.installId, sessionId),
        // One score per (install, case, asset): an override or a redistill re-emits the SAME id,
        // which Langfuse upserts — without it every re-emit added a second, contradicting score.
        id: attributionScoreId(e),
        name: 'asset.contribution',
        value,
        comment: e['gen_ai.evaluation.explanation'],
        metadata
      })
    }
    if (intents.length > 0) this.push(intents)
  }

  /** One trace per finished distill job (spec 2026-10-24 distillation-health). The intents come
   *  pre-built from `distillTelemetry.jobIntents`; this is the seam, not the builder. */
  traceDistillJob(intents: ObservationIntent[]): void {
    this.push(intents)
  }

  /** A proposal decision as a `proposal.outcome` score (deterministic id -> Langfuse upserts). */
  scoreProposal(intent: ScoreIntent): void {
    if (intent.kind !== 'score') return
    this.push([intent])
  }

  private push(intents: ObservationIntent[]): void {
    if (intents.length === 0) return
    try {
      this.sink.emit(intents)
    } catch (err) {
      this.error = err instanceof Error ? err.message : String(err)
    }
  }

  async flush(): Promise<void> {
    try {
      await this.sink.flush()
    } catch (err) {
      this.error = err instanceof Error ? err.message : String(err)
    }
  }

  async shutdown(): Promise<void> {
    try {
      await this.sink.shutdown()
    } catch (err) {
      this.error = err instanceof Error ? err.message : String(err)
    }
  }

  lastError(): string | null {
    return this.error
  }
}
