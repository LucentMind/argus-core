import { createHash } from 'node:crypto'
import type { ObservationIntent, TraceRootIntent } from './intent'
import type { ObservationSink } from './sink'

export interface SpanContextLike {
  traceId: string
  spanId: string
  traceFlags: number
}

export interface ObservationHandle {
  spanId: string
  end(endTime?: number): void
}

export interface StartOpts {
  asType?: 'span' | 'generation' | 'tool' | 'event'
  startTime?: number
  parentSpanContext: SpanContextLike
  /**
   * Trace-level name, set only on a root observation. Naming an observation does
   * NOT name its trace — without this the trace is a blank row in Langfuse's
   * traces list. See __fixtures__/EVIDENCE.md Q4.
   */
  traceName?: string
  /** Trace-level metadata, set only on a root observation. */
  traceMetadata?: Record<string, unknown>
}

/** The seam between sink logic and the Langfuse/OTel SDK. */
export interface TracingApi {
  createTraceId(seed: string): Promise<string>
  startObservation(
    name: string,
    attributes: Record<string, unknown>,
    opts: StartOpts
  ): ObservationHandle
  createScore(o: { traceId: string; name: string; value: number; comment?: string }): Promise<void>
  forceFlush(): Promise<void>
  shutdown(): Promise<void>
}

/**
 * Deterministic 16-hex synthetic parent span id. The span it names is never
 * emitted; it exists only to force the root observation onto a trace id we
 * derived from the seed. Never all-zeros (invalid per the OTel spec).
 */
export function synthSpanId(seed: string): string {
  const hex = createHash('sha256').update(seed).digest('hex').slice(0, 16)
  return /^0+$/.test(hex) ? `1${hex.slice(1)}` : hex
}

export class LangfuseSink implements ObservationSink {
  private roots = new Map<string, Promise<SpanContextLike>>()
  private pending = new Set<Promise<void>>()
  private error: string | null = null
  private stopped = false

  constructor(private api: TracingApi) {}

  emit(intents: ObservationIntent[]): void {
    if (this.stopped) return
    for (const intent of intents) this.track(this.apply(intent))
  }

  private track(p: Promise<void>): void {
    const wrapped = p.catch((err) => {
      this.error = err instanceof Error ? err.message : String(err)
    })
    this.pending.add(wrapped)
    void wrapped.finally(() => this.pending.delete(wrapped))
  }

  /**
   * Resolves (and caches) the root span context for a seed. Callers may pass
   * the trace-root intent when they have it; intents that arrive before their
   * root fall back to naming the trace after its seed. Because the trace id
   * derives from the seed alone, a later root lands in the same trace.
   */
  private rootFor(seed: string, root: TraceRootIntent | null): Promise<SpanContextLike> {
    const cached = this.roots.get(seed)
    if (cached) return cached
    const promise = (async () => {
      const traceId = await this.api.createTraceId(seed)
      const parent: SpanContextLike = {
        traceId,
        spanId: synthSpanId(seed),
        traceFlags: 1
      }
      const span = this.api.startObservation(
        root?.name ?? seed,
        { metadata: root?.metadata ?? {} },
        {
          parentSpanContext: parent,
          // Trace-level naming is separate from observation naming — see
          // __fixtures__/EVIDENCE.md Q4. Omitting it yields an unnamed trace.
          //
          // Deliberately NOT falling back to `seed`: an intent can reach the sink
          // without its trace-root (a scoreFinding() for a session that ended in an
          // earlier app run). That trace already exists in Langfuse with its real
          // name, and writing the raw seed here would overwrite it. Only a genuine
          // trace-root names the trace.
          ...(root ? { traceName: root.name, traceMetadata: root.metadata } : {})
        }
      )
      span.end()
      return { traceId, spanId: span.spanId, traceFlags: 1 }
    })()
    this.roots.set(seed, promise)
    return promise
  }

  private async apply(intent: ObservationIntent): Promise<void> {
    const ctx = await this.rootFor(intent.seed, intent.kind === 'trace-root' ? intent : null)
    if (intent.kind === 'trace-root') return // the root itself was created by rootFor

    if (intent.kind === 'score') {
      await this.api.createScore({
        traceId: ctx.traceId,
        name: intent.name,
        value: intent.value,
        comment: intent.comment
      })
      return
    }

    const common = {
      parentSpanContext: ctx,
      startTime: (intent as { startTime?: number }).startTime
    }

    if (intent.kind === 'generation') {
      const span = this.api.startObservation(
        intent.name,
        {
          model: intent.model,
          ...(intent.usage ? { usageDetails: intent.usage } : {}),
          ...(intent.costUsd != null ? { costDetails: { total: intent.costUsd } } : {}),
          ...(intent.input != null ? { input: intent.input } : {}),
          ...(intent.output != null ? { output: intent.output } : {})
        },
        { ...common, asType: 'generation' }
      )
      span.end(intent.endTime)
      return
    }

    if (intent.kind === 'tool') {
      const span = this.api.startObservation(
        intent.name,
        {
          level: intent.isError ? 'ERROR' : 'DEFAULT',
          ...(intent.output != null ? { output: intent.output } : {})
        },
        { ...common, asType: 'tool' }
      )
      span.end(intent.endTime)
      return
    }

    // intent.kind === 'event'
    const span = this.api.startObservation(
      intent.name,
      {
        level: intent.level ?? 'DEFAULT',
        ...(intent.metadata ? { metadata: intent.metadata } : {})
      },
      { ...common, asType: 'event' }
    )
    span.end()
  }

  async flush(): Promise<void> {
    while (this.pending.size > 0) await Promise.all([...this.pending])
    await this.api.forceFlush()
  }

  async shutdown(): Promise<void> {
    if (this.stopped) return
    this.stopped = true
    await this.flush()
    await this.api.shutdown()
  }

  lastError(): string | null {
    return this.error
  }
}
