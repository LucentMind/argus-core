import { randomBytes } from 'node:crypto'
import type {
  EventIntent,
  GenerationIntent,
  ObservationIntent,
  ScoreIntent,
  ToolIntent,
  TraceRootIntent
} from '../../intent'
import type { ObservationSink } from '../../sink'
import { synthSpanId } from '../langfuse/sink'
import { traceIdFromSeed } from '../otlp/sink'
import type { DatadogIntake } from './intake'

/** Flush cadence when nothing forces an earlier send. `unref`'d: never keeps the app alive. */
export const FLUSH_INTERVAL_MS = 5_000
/** A buffer is sent early once its serialized size passes this. Datadog's intake accepts a few MB
 *  per request; one MB keeps every request far from that limit. */
export const MAX_CHUNK_BYTES = 1_000_000
/** ...or once it holds this many records, whichever comes first. */
export const MAX_CHUNK_RECORDS = 500
/** Datadog tags are capped at 200 characters; a longer one is truncated by the intake anyway. */
const MAX_TAG_LENGTH = 200
/** Score metadata keys that carry free-text reasoning (sent as `reasoning`, not as tags). */
const REASONING_KEYS = new Set(['gen_ai.evaluation.explanation'])

/** Decimal string of a 64-bit hex id, top bit cleared (so a signed int64 parser downstream never
 *  sees a negative id), never zero. Datadog wants span ids as decimal strings. */
export function hexToDecimalId(hex16: string): string {
  const n = BigInt(`0x${hex16}`) & 0x7fffffffffffffffn
  return (n === 0n ? 1n : n).toString()
}

/** The root span id for a seed: deterministic, so a child or score emitted in a LATER run (after a
 *  restart) still parents to the real root that an earlier run sent. */
export function rootSpanIdFromSeed(seed: string): string {
  return hexToDecimalId(synthSpanId(seed))
}

/** The trace id for a seed: the same 32-hex derivation as the Langfuse and OTLP adapters. Datadog
 *  accepts a 128-bit trace id as 32 lowercase hex. */
export function datadogTraceId(seed: string): string {
  return traceIdFromSeed(seed)
}

const randomSpanId = (): string => hexToDecimalId(randomBytes(8).toString('hex'))

/** `meta.metadata` values must be string, number or bool: objects/arrays are JSON-encoded,
 *  nullish dropped. */
export function metaValue(v: unknown): string | number | boolean | undefined {
  if (v == null) return undefined
  if (typeof v === 'string' || typeof v === 'boolean') return v
  if (typeof v === 'number') return Number.isFinite(v) ? v : String(v)
  if (typeof v === 'bigint') return v.toString()
  try {
    return JSON.stringify(v)
  } catch {
    return String(v)
  }
}

function metadataOf(
  source: Record<string, unknown> | undefined,
  prefix = ''
): Record<string, string | number | boolean> {
  const out: Record<string, string | number | boolean> = {}
  for (const [k, v] of Object.entries(source ?? {})) {
    const m = metaValue(v)
    if (m !== undefined) out[prefix && !k.startsWith(prefix) ? `${prefix}${k}` : k] = m
  }
  return out
}

/** One `key:value` Datadog tag, value stringified and the whole tag capped at 200 chars. */
export function tag(key: string, value: unknown): string | null {
  const v = metaValue(value)
  if (v === undefined) return null
  return `${key}:${String(v)}`.slice(0, MAX_TAG_LENGTH)
}

/**
 * Datadog evaluation labels must start with a letter and contain only ASCII alphanumerics,
 * underscores or hyphens; the intake converts anything else to `_`. Do that conversion here so
 * the label Argus documents is the label Datadog shows (`asset.contribution` → `asset_contribution`).
 */
export function evalLabel(name: string): string {
  const s = name.replace(/[^A-Za-z0-9_-]/g, '_')
  return (/^[A-Za-z]/.test(s) ? s : `argus_${s}`).slice(0, 200)
}

/** `anthropic` for Claude models; otherwise unknown (the intent does not carry the driver). */
export function modelProvider(model: string): string | undefined {
  return /^claude/i.test(model) ? 'anthropic' : undefined
}

const nsOf = (ms: number): number => Math.round(ms * 1e6)
/** Datadog rejects a span with `duration` 0 (`span duration has to be greater than zero`) and
 *  with it the WHOLE request, so a "zero-length" root or event is sent as 1 ns. Seen live against
 *  the real intake, 2026-11-17. */
export const MIN_DURATION_NS = 1

export interface DatadogSpan {
  name: string
  span_id: string
  trace_id: string
  parent_id: string
  start_ns: number
  duration: number
  status: 'ok' | 'error'
  session_id?: string
  meta: {
    kind: 'agent' | 'llm' | 'tool' | 'task'
    model_name?: string
    model_provider?: string
    metadata?: Record<string, string | number | boolean>
    input?: { value?: string; messages?: { role: string; content: string }[] }
    output?: { value?: string; messages?: { role: string; content: string }[] }
    error?: { message: string }
  }
  metrics?: Record<string, number>
}

export interface DatadogEval {
  eval_scope: 'trace'
  join_on: { span: { span_id: string; trace_id: string } }
  ml_app: string
  timestamp_ms: number
  metric_type: 'score'
  label: string
  score_value: number
  reasoning?: string
  tags: string[]
}

export interface DatadogSinkOptions {
  captureContent: boolean
  mlApp: string
  /** Applied to every span payload and every evaluation (`service:`, `version:`, `env:`, ...). */
  tags: string[]
  flushIntervalMs?: number
  maxChunkBytes?: number
  maxChunkRecords?: number
  now?: () => number
}

interface Buffer<T> {
  items: T[]
  bytes: number
}

/**
 * ObservationSink → Datadog LLM Observability, over its native HTTP intake.
 *
 * Every intent becomes one finished record at once (spans are never held open, as in the other
 * adapters): `trace-root` → an `agent` span, `generation` → `llm`, `tool` → `tool`, `event` → a
 * zero-length `task` span, `score` → an evaluation on the trace. Records are buffered in memory
 * (`emit` stays synchronous) and POSTed on `flush()`, every `FLUSH_INTERVAL_MS`, or as soon as a
 * buffer passes its size cap. A failed POST drops that chunk and latches `lastError()` until a
 * later POST succeeds.
 *
 * Identity: trace id = `traceIdFromSeed(seed)` (shared with Langfuse/OTLP); the root's span id is
 * derived from the seed too, so children and scores of a session whose root went out in an
 * earlier run still join it. A seed with no root at all (a score for a session from before the
 * provider was enabled) yields an orphan child / an evaluation that joins nothing.
 */
export class DatadogSink implements ObservationSink {
  private spans: Buffer<DatadogSpan> = { items: [], bytes: 0 }
  private evals: Buffer<DatadogEval> = { items: [], bytes: 0 }
  /** seed → case slug, for the roots seen in this run (one root per seed, children inherit the
   *  session id). */
  private roots = new Map<string, string>()
  /** `<trace id>|<label>` → last evaluation timestamp used. Datadog rejects the WHOLE request
   *  (`HTTP 400 · evaluation metric is a duplicate`) when two evaluations share trace, span,
   *  label and millisecond timestamp, which several asset scores of one case emitted together
   *  always do. Bumping each to a strictly later millisecond keeps them distinct. Seen live
   *  against the real intake, 2026-11-17. */
  private lastEvalMs = new Map<string, number>()
  private pending = new Set<Promise<void>>()
  private timer: NodeJS.Timeout | null = null
  /** Latched per endpoint: a success on one must not clear a failure on the other (a rejected
   *  spans POST was hidden by the evals POST that succeeded right after it, seen live). */
  private errors: { spans: string | null; evals: string | null; local: string | null } = {
    spans: null,
    evals: null,
    local: null
  }
  private stopped = false
  private readonly now: () => number

  constructor(
    private intake: DatadogIntake,
    private opts: DatadogSinkOptions
  ) {
    this.now = opts.now ?? Date.now
  }

  emit(intents: ObservationIntent[]): void {
    if (this.stopped) return
    for (const intent of intents) {
      try {
        this.apply(intent)
      } catch (err) {
        this.latch(err)
      }
    }
    this.schedule()
  }

  private latch(err: unknown, channel: 'spans' | 'evals' | 'local' = 'local'): void {
    const msg = err instanceof Error ? err.message : String(err)
    if (msg !== this.errors[channel])
      console.error(`[observability] Datadog ${channel} export failed`, msg)
    this.errors[channel] = msg
  }

  private apply(i: ObservationIntent): void {
    switch (i.kind) {
      case 'trace-root':
        return this.root(i)
      case 'generation':
        return this.pushSpan(this.generation(i))
      case 'tool':
        return this.pushSpan(this.tool(i))
      case 'event':
        return this.pushSpan(this.event(i))
      case 'score':
        return this.pushEval(this.score(i))
    }
  }

  /** Common span fields for a child of `seed`'s root. */
  private child(
    seed: string,
    name: string,
    startMs: number | undefined,
    endMs: number | undefined
  ): Omit<DatadogSpan, 'meta'> {
    const start = startMs ?? endMs ?? this.now()
    const end = endMs ?? start
    const session = this.roots.get(seed)
    return {
      name,
      span_id: randomSpanId(),
      trace_id: datadogTraceId(seed),
      parent_id: rootSpanIdFromSeed(seed),
      start_ns: nsOf(start),
      duration: Math.max(MIN_DURATION_NS, nsOf(end) - nsOf(start)),
      status: 'ok',
      ...(session ? { session_id: session } : {})
    }
  }

  private root(i: TraceRootIntent): void {
    if (this.roots.has(i.seed)) return
    this.roots.set(i.seed, i.caseSlug)
    this.pushSpan({
      name: i.name,
      span_id: rootSpanIdFromSeed(i.seed),
      trace_id: datadogTraceId(i.seed),
      parent_id: 'undefined',
      start_ns: nsOf(this.now()),
      duration: MIN_DURATION_NS,
      status: 'ok',
      session_id: i.caseSlug,
      meta: {
        kind: 'agent',
        metadata: { ...metadataOf(i.metadata, 'argus.'), 'argus.case.slug': i.caseSlug }
      }
    })
  }

  private generation(i: GenerationIntent): DatadogSpan {
    const metrics: Record<string, number> = {}
    if (i.usage?.input != null) metrics.input_tokens = i.usage.input
    if (i.usage?.output != null) metrics.output_tokens = i.usage.output
    if (i.usage?.input != null || i.usage?.output != null)
      metrics.total_tokens = (i.usage?.input ?? 0) + (i.usage?.output ?? 0)
    if (i.costUsd != null) metrics.total_cost = i.costUsd
    const provider = modelProvider(i.model)
    const content = this.opts.captureContent
    return {
      ...this.child(i.seed, i.name, i.startTime, i.endTime),
      meta: {
        kind: 'llm',
        model_name: i.model,
        ...(provider ? { model_provider: provider } : {}),
        ...(content && i.input != null
          ? { input: { messages: [{ role: 'user', content: i.input }] } }
          : {}),
        ...(content && i.output != null
          ? { output: { messages: [{ role: 'assistant', content: i.output }] } }
          : {})
      },
      ...(Object.keys(metrics).length > 0 ? { metrics } : {})
    }
  }

  private tool(i: ToolIntent): DatadogSpan {
    return {
      ...this.child(i.seed, i.name, i.startTime, i.endTime),
      ...(i.isError ? { status: 'error' as const } : {}),
      meta: {
        kind: 'tool',
        ...(i.isError ? { error: { message: `tool ${i.name} failed` } } : {}),
        ...(this.opts.captureContent && i.output != null ? { output: { value: i.output } } : {})
      }
    }
  }

  private event(i: EventIntent): DatadogSpan {
    const now = this.now()
    const metadata = { ...metadataOf(i.metadata), 'argus.level': i.level ?? 'DEFAULT' }
    const errorMessage = i.level === 'ERROR' ? metaValue(i.metadata?.message) : undefined
    return {
      ...this.child(i.seed, i.name, now, now),
      ...(i.level === 'ERROR' ? { status: 'error' as const } : {}),
      meta: {
        kind: 'task',
        metadata,
        ...(i.level === 'ERROR' ? { error: { message: String(errorMessage ?? i.name) } } : {})
      }
    }
  }

  private score(i: ScoreIntent): DatadogEval {
    const tags = [
      ...this.opts.tags,
      // The explanation is free text and already the `reasoning`: never a tag.
      ...Object.entries(i.metadata ?? {})
        .filter(([k]) => !REASONING_KEYS.has(k))
        .map(([k, v]) => tag(k, v)),
      tag('argus.score.name', i.name),
      i.id != null ? tag('argus.score.id', i.id) : null
    ].filter((t): t is string => t !== null)
    const traceId = datadogTraceId(i.seed)
    const label = evalLabel(i.name)
    const key = `${traceId}|${label}`
    const timestamp = Math.max(this.now(), (this.lastEvalMs.get(key) ?? -Infinity) + 1)
    this.lastEvalMs.set(key, timestamp)
    return {
      eval_scope: 'trace',
      join_on: { span: { span_id: rootSpanIdFromSeed(i.seed), trace_id: traceId } },
      ml_app: this.opts.mlApp,
      timestamp_ms: timestamp,
      metric_type: 'score',
      label,
      score_value: i.value,
      ...(i.comment != null && i.comment !== '' ? { reasoning: i.comment } : {}),
      tags
    }
  }

  private pushSpan(s: DatadogSpan): void {
    this.push(this.spans, s, () => this.sendSpans())
  }

  private pushEval(e: DatadogEval): void {
    this.push(this.evals, e, () => this.sendEvals())
  }

  private push<T>(buf: Buffer<T>, item: T, send: () => void): void {
    buf.items.push(item)
    buf.bytes += JSON.stringify(item).length
    if (
      buf.bytes >= (this.opts.maxChunkBytes ?? MAX_CHUNK_BYTES) ||
      buf.items.length >= (this.opts.maxChunkRecords ?? MAX_CHUNK_RECORDS)
    )
      send()
  }

  private take<T>(buf: Buffer<T>): T[] {
    const items = buf.items
    buf.items = []
    buf.bytes = 0
    return items
  }

  private sendSpans(): void {
    const spans = this.take(this.spans)
    if (spans.length === 0) return
    this.track(
      'spans',
      this.intake.postSpans({
        data: {
          type: 'span',
          attributes: { ml_app: this.opts.mlApp, tags: this.opts.tags, spans }
        }
      })
    )
  }

  private sendEvals(): void {
    const metrics = this.take(this.evals)
    if (metrics.length === 0) return
    this.track(
      'evals',
      this.intake.postEvals({ data: { type: 'evaluation_metric', attributes: { metrics } } })
    )
  }

  /** Every POST settles into its endpoint's latch (fail latches, a later success on the SAME
   *  endpoint clears) and never rejects. */
  private track(channel: 'spans' | 'evals', post: Promise<void>): void {
    const p: Promise<void> = Promise.resolve(post)
      .then(
        () => {
          this.errors[channel] = null
        },
        (err: unknown) => this.latch(err, channel)
      )
      .finally(() => this.pending.delete(p))
    this.pending.add(p)
  }

  /** Called synchronously from `emit`: an intake that throws (rather than rejects) is latched. */
  private sendAll(): void {
    for (const send of [() => this.sendSpans(), () => this.sendEvals()]) {
      try {
        send()
      } catch (err) {
        this.latch(err)
      }
    }
  }

  private schedule(): void {
    if (this.timer || this.stopped) return
    if (this.spans.items.length === 0 && this.evals.items.length === 0) return
    this.timer = setTimeout(() => {
      this.timer = null
      this.sendAll()
    }, this.opts.flushIntervalMs ?? FLUSH_INTERVAL_MS)
    this.timer.unref?.()
  }

  private clearTimer(): void {
    if (this.timer) clearTimeout(this.timer)
    this.timer = null
  }

  async flush(): Promise<void> {
    this.clearTimer()
    this.sendAll()
    await Promise.all([...this.pending])
  }

  async shutdown(): Promise<void> {
    if (this.stopped) return
    // Final flush BEFORE stopping, so what was buffered still goes out.
    await this.flush()
    this.stopped = true
    this.clearTimer()
    this.roots.clear()
  }

  lastError(): string | null {
    const { spans, evals, local } = this.errors
    const parts = [spans && `spans: ${spans}`, evals && `evaluations: ${evals}`, local].filter(
      (x): x is string => Boolean(x)
    )
    return parts.length ? parts.join(' | ') : null
  }
}
