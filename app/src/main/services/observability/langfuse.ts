import { createHash } from 'node:crypto'
import type { AgentEvent } from '../../../shared/agent-events'
import type { FindingRow } from '../../../shared/observability'
import type { AssetAttributionEvent } from '../../../shared/attribution'
import { seedFor } from './intent'
import type { ObservationIntent } from './intent'
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

/**
 * Holds reducer state and forwards the resulting intents to a sink.
 *
 * Error policy is deliberately split: a throw from `reduce` is a logic bug and
 * is logged loudly without touching `lastError()`, so it is never reported as
 * a connector fault. A throw from `sink.emit` would be a network or config
 * condition and is recorded via `lastError()`.
 *
 * Note that path is currently inert: the concrete `LangfuseSink` never throws
 * synchronously — it swallows failures into its own private field — so `lastError()`
 * is not populated by a real sink failure, and no caller reads it either. Runtime
 * ingestion failures are therefore not surfaced anywhere today; the Langfuse health
 * row runs an independent credential probe (`probeLangfuseCredentials`). Wiring
 * runtime failures into health is a deliberate open question, not an oversight.
 */
export class LangfuseExporter {
  private state: ExporterState = initialState()
  private error: string | null = null

  constructor(
    private sink: ObservationSink,
    private opts: { captureContent: boolean }
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

  scoreFinding(row: FindingRow | null): void {
    if (!row || row.sessionId == null || row.reviewState === 'pending') return
    this.push([
      {
        kind: 'score',
        seed: seedFor(row.sessionId),
        name: 'finding_accepted',
        value: row.reviewState === 'accepted' ? 1 : 0
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
        seed: seedFor(sessionId),
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
