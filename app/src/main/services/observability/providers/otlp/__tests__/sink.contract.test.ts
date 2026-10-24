import {
  InMemorySpanExporter,
  SimpleSpanProcessor,
  type ReadableSpan,
  type Span,
  type SpanExporter,
  type SpanProcessor
} from '@opentelemetry/sdk-trace-node'
import { ExportResultCode } from '@opentelemetry/core'
import { OtlpSink, traceIdFromSeed } from '../sink'
import { createOtlpTracingWith, observeExports } from '../tracing'
import * as S from '../semconv'
import {
  describeSinkContract,
  CONTRACT_SEED,
  type ContractHarness
} from '../../__tests__/sinkContract'

/**
 * The OTLP sink keeps each root span OPEN (it carries the event/score span events)
 * until shutdown, so the exporter alone never sees a root before shutdown. The harness
 * therefore records every span at `onStart` (the live Span object is readable as it
 * mutates) — which is also exactly the "attempt" count: a start reaches the SDK before
 * any export can accept or reject it.
 */
function recording(inner: SpanProcessor, started: Span[]): SpanProcessor {
  return {
    onStart: (span, ctx) => {
      started.push(span)
      inner.onStart(span, ctx)
    },
    onEnd: (span) => inner.onEnd(span),
    forceFlush: () => inner.forceFlush(),
    shutdown: () => inner.shutdown()
  }
}

function harness(opts: { captureContent: boolean }): ContractHarness {
  const mem = new InMemorySpanExporter()
  let throwing = false
  const backend: SpanExporter = {
    export: (spans, cb) =>
      throwing
        ? cb({ code: ExportResultCode.FAILED, error: new Error('backend down') })
        : mem.export(spans, cb),
    shutdown: () => mem.shutdown(),
    forceFlush: () => Promise.resolve()
  }
  const box = { last: null as string | null }
  const started: Span[] = []
  const tracing = createOtlpTracingWith(
    recording(new SimpleSpanProcessor(observeExports(backend, box)), started),
    { 'service.name': 'argus' },
    box
  )
  const sink = new OtlpSink(tracing, opts)
  const spans = (): ReadableSpan[] => started
  const isRoot = (s: ReadableSpan): boolean =>
    s.attributes[S.ATTR_GEN_AI_OPERATION_NAME] === S.OP_INVOKE_AGENT
  return {
    sink,
    settle: async () => {
      await new Promise((r) => setTimeout(r, 0))
    },
    backendThrows: () => {
      throwing = true
    },
    recorded: () => {
      const root = spans().find(
        (s) => isRoot(s) && s.spanContext().traceId === traceIdFromSeed(CONTRACT_SEED)
      )
      const rootId = root?.spanContext().spanId
      // §4.5: generation/tool are child spans of the root; an `event` intent is a span
      // EVENT on the root (not a span) — it is the third "child" the contract counts.
      const childSpans = spans().filter(
        (s) => rootId != null && s.parentSpanContext?.spanId === rootId
      )
      const childEvents = (root?.events ?? []).filter(
        (e) => e.name !== S.EVENT_GEN_AI_EVALUATION_RESULT
      )
      return {
        roots: spans().filter(isRoot).length,
        childrenOfRoot: childSpans.length + childEvents.length,
        attempts: spans().length,
        scoresForSeed: (seed) =>
          spans()
            .filter((s) => s.spanContext().traceId === traceIdFromSeed(seed))
            .flatMap((s) => s.events)
            .filter((e) => e.name === S.EVENT_GEN_AI_EVALUATION_RESULT).length,
        containsText: (t) =>
          JSON.stringify(
            spans().map((s) => [s.name, s.attributes, s.events.map((e) => [e.name, e.attributes])])
          ).includes(t)
      }
    }
  }
}

describeSinkContract('OtlpSink', harness)
