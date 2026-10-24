import { createHash } from 'node:crypto'
import {
  context,
  trace,
  SpanKind,
  SpanStatusCode,
  type Attributes,
  type AttributeValue,
  type Context,
  type SpanContext
} from '@opentelemetry/api'
import type { ObservationIntent, ScoreIntent, TraceRootIntent } from '../../intent'
import type { ObservationSink } from '../../sink'
import { synthSpanId } from '../langfuse/sink'
import type { OtlpTracing } from './tracing'
import * as S from './semconv'

/**
 * 32-hex trace id derived from the seed: sha256 → first 32 hex, the same derivation
 * as Langfuse's `createTraceId(seed)`, so both adapters put a session in the same
 * trace id and a score after an app restart lands in that trace. Never all zeros
 * (invalid per the OTel spec).
 */
export function traceIdFromSeed(seed: string): string {
  const hex = createHash('sha256').update(seed).digest('hex').slice(0, 32)
  return /^0+$/.test(hex) ? `1${hex.slice(1)}` : hex
}

/** The synthetic parent span id for a seed — one derivation, shared with the Langfuse sink. */
export function spanIdFromSeed(seed: string): string {
  return synthSpanId(seed)
}

/** OTel attribute values must be primitives: objects/arrays are JSON-encoded, nullish dropped. */
function toAttr(v: unknown): AttributeValue | undefined {
  if (v == null) return undefined
  if (typeof v === 'string' || typeof v === 'number' || typeof v === 'boolean') return v
  try {
    return JSON.stringify(v)
  } catch {
    return String(v)
  }
}

function attrs(source: Record<string, unknown> | undefined, prefix = ''): Attributes {
  const out: Attributes = {}
  for (const [k, v] of Object.entries(source ?? {})) {
    const a = toAttr(v)
    if (a !== undefined) out[prefix && !k.startsWith(prefix) ? `${prefix}${k}` : k] = a
  }
  return out
}

const at = (ms: number | undefined): Date | undefined => (ms != null ? new Date(ms) : undefined)

/** GenAI-semconv message shape for the content events. */
const messages = (role: 'user' | 'assistant', text: string): string =>
  JSON.stringify([{ role, parts: [{ type: 'text', content: text }] }])

/**
 * ObservationSink → OTLP spans in the OpenTelemetry GenAI conventions (spec §4.5).
 *
 * Span lifetimes mirror the Langfuse sink exactly: one root per seed, started on the
 * `trace-root` intent under a synthetic parent `{ traceIdFromSeed(seed),
 * synthSpanId(seed) }` (so its trace id is seed-derived), ended at once (zero-length),
 * and only its SpanContext cached. Children parent to the cached context; a child
 * intent with no cached root (e.g. after a restart) attaches to the same synthetic
 * parent and never creates a placeholder root (nor populates the cache).
 * Generation/tool spans start at the intent's `startTime` and end at its `endTime`;
 * `event`/`score` intents each become a short zero-length child span (`event <name>` /
 * `evaluation <name>`) carrying the span event, ended immediately.
 *
 * No span is ever left open across intents, so a crash loses nothing already emitted
 * and a batch processor exports every span — the root included — on the next flush.
 *
 * `captureContent` is per adapter: when off, no `gen_ai.input/output.messages` events
 * and no tool result are emitted, whatever the intent carries.
 */
export class OtlpSink implements ObservationSink {
  private roots = new Map<string, SpanContext>()
  private error: string | null = null
  private stopped = false

  constructor(
    private tracing: OtlpTracing,
    private opts: { captureContent: boolean }
  ) {}

  emit(intents: ObservationIntent[]): void {
    if (this.stopped) return
    for (const intent of intents) {
      try {
        this.apply(intent)
      } catch (err) {
        this.latch(err)
      }
    }
  }

  private latch(err: unknown): void {
    const msg = err instanceof Error ? err.message : String(err)
    if (msg !== this.error) console.error('[observability] OTLP sink failed to record', err)
    this.error = msg
  }

  private syntheticParent(seed: string): Context {
    return trace.setSpanContext(context.active(), {
      traceId: traceIdFromSeed(seed),
      spanId: spanIdFromSeed(seed),
      traceFlags: 1
    })
  }

  /** The cached root's context when there is one, else the synthetic parent (never cached). */
  private parentFor(seed: string): Context {
    const root = this.roots.get(seed)
    return root ? trace.setSpanContext(context.active(), root) : this.syntheticParent(seed)
  }

  private startRoot(i: TraceRootIntent): void {
    if (this.roots.has(i.seed)) return
    const now = new Date()
    const span = this.tracing.tracer.startSpan(
      `${S.OP_INVOKE_AGENT} ${i.name}`,
      {
        kind: SpanKind.CLIENT,
        startTime: now,
        attributes: {
          ...attrs(i.metadata, 'argus.'),
          [S.ATTR_GEN_AI_OPERATION_NAME]: S.OP_INVOKE_AGENT,
          [S.ATTR_GEN_AI_AGENT_NAME]: 'argus',
          [S.ATTR_GEN_AI_CONVERSATION_ID]: i.caseSlug,
          [S.ATTR_ARGUS_CASE_SLUG]: i.caseSlug
        }
      },
      this.syntheticParent(i.seed)
    )
    span.end(now) // zero-length: never held open
    this.roots.set(i.seed, span.spanContext())
  }

  /** A zero-length child span (at now) under `parentFor(seed)` that carries one span event. */
  private eventSpan(
    seed: string,
    spanName: string,
    op: string | undefined,
    eventName: string,
    a: Attributes
  ): void {
    const now = new Date()
    const span = this.tracing.tracer.startSpan(
      spanName,
      {
        kind: SpanKind.INTERNAL,
        startTime: now,
        attributes: op ? { [S.ATTR_GEN_AI_OPERATION_NAME]: op } : {}
      },
      this.parentFor(seed)
    )
    span.addEvent(eventName, a, now)
    span.end(now)
  }

  private scoreAttrs(i: ScoreIntent): Attributes {
    return {
      // Metadata verbatim (attribution keys are already `argus.*`); core keys win.
      ...attrs(i.metadata),
      [S.ATTR_GEN_AI_EVALUATION_NAME]: i.name,
      [S.ATTR_GEN_AI_EVALUATION_SCORE_VALUE]: i.value,
      ...(i.comment != null ? { [S.ATTR_GEN_AI_EVALUATION_EXPLANATION]: i.comment } : {}),
      ...(i.id != null ? { [S.ATTR_ARGUS_SCORE_ID]: i.id } : {})
    }
  }

  private apply(i: ObservationIntent): void {
    switch (i.kind) {
      case 'trace-root':
        this.startRoot(i)
        return

      case 'generation': {
        const span = this.tracing.tracer.startSpan(
          `${S.OP_CHAT} ${i.model}`,
          {
            kind: SpanKind.CLIENT,
            startTime: at(i.startTime),
            attributes: {
              [S.ATTR_GEN_AI_OPERATION_NAME]: S.OP_CHAT,
              [S.ATTR_GEN_AI_REQUEST_MODEL]: i.model,
              ...(i.usage?.input != null
                ? { [S.ATTR_GEN_AI_USAGE_INPUT_TOKENS]: i.usage.input }
                : {}),
              ...(i.usage?.output != null
                ? { [S.ATTR_GEN_AI_USAGE_OUTPUT_TOKENS]: i.usage.output }
                : {}),
              ...(i.costUsd != null ? { [S.ATTR_ARGUS_COST_USD]: i.costUsd } : {})
            }
          },
          this.parentFor(i.seed)
        )
        if (this.opts.captureContent && i.input != null) {
          span.addEvent(
            S.ATTR_GEN_AI_INPUT_MESSAGES,
            { [S.ATTR_GEN_AI_INPUT_MESSAGES]: messages('user', i.input) },
            at(i.startTime)
          )
        }
        if (this.opts.captureContent && i.output != null) {
          span.addEvent(
            S.ATTR_GEN_AI_OUTPUT_MESSAGES,
            { [S.ATTR_GEN_AI_OUTPUT_MESSAGES]: messages('assistant', i.output) },
            at(i.endTime)
          )
        }
        span.end(at(i.endTime))
        return
      }

      case 'tool': {
        const span = this.tracing.tracer.startSpan(
          `${S.OP_EXECUTE_TOOL} ${i.name}`,
          {
            kind: SpanKind.INTERNAL,
            startTime: at(i.startTime),
            attributes: {
              [S.ATTR_GEN_AI_OPERATION_NAME]: S.OP_EXECUTE_TOOL,
              [S.ATTR_GEN_AI_TOOL_NAME]: i.name,
              ...(this.opts.captureContent && i.output != null
                ? { [S.ATTR_GEN_AI_TOOL_CALL_RESULT]: i.output }
                : {})
            }
          },
          this.parentFor(i.seed)
        )
        if (i.isError) span.setStatus({ code: SpanStatusCode.ERROR })
        span.end(at(i.endTime))
        return
      }

      case 'event':
        this.eventSpan(i.seed, `event ${i.name}`, undefined, i.name, {
          ...attrs(i.metadata),
          [S.ATTR_ARGUS_LEVEL]: i.level ?? 'DEFAULT'
        })
        return

      case 'score':
        this.eventSpan(
          i.seed,
          `${S.OP_EVALUATION} ${i.name}`,
          S.OP_EVALUATION,
          S.EVENT_GEN_AI_EVALUATION_RESULT,
          this.scoreAttrs(i)
        )
        return
    }
  }

  async flush(): Promise<void> {
    try {
      await this.tracing.forceFlush()
    } catch (err) {
      this.latch(err)
    }
  }

  async shutdown(): Promise<void> {
    if (this.stopped) return
    this.stopped = true
    this.roots.clear() // contexts only: there is no open span to end
    await this.flush()
    try {
      await this.tracing.shutdown()
    } catch (err) {
      this.latch(err)
    }
  }

  /** The sink's own recording error first, else the latest export failure (read live, never folded). */
  lastError(): string | null {
    return this.error ?? this.tracing.lastExportError()
  }
}
