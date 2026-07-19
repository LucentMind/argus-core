import type { AgentEvent } from '../../../shared/agent-events'
import type { FindingRow } from '../../../shared/observability'
import { seedFor } from './intent'
import type { ObservationIntent } from './intent'
import { initialState, reduce, type ExporterState } from './reducer'
import type { ObservationSink } from './sink'

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
