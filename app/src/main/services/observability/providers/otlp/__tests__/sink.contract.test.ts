import {
  SimpleSpanProcessor,
  type ReadableSpan,
  type SpanExporter
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
 * Every OTLP span (the root included) is ended as soon as its intent is applied, so
 * the exporter sees everything on `flush`. The fake backend counts each span it is
 * handed BEFORE it accepts or rejects it (`attempts`), and keeps the accepted ones in
 * its own buffer (`InMemorySpanExporter.shutdown()` would clear it).
 */
function harness(opts: { captureContent: boolean }): ContractHarness {
  const finished: ReadableSpan[] = []
  let attempts = 0
  let throwing = false
  const backend: SpanExporter = {
    export: (spans, cb) => {
      attempts += spans.length
      if (throwing) {
        cb({ code: ExportResultCode.FAILED, error: new Error('backend down') })
        return
      }
      finished.push(...spans)
      cb({ code: ExportResultCode.SUCCESS })
    },
    shutdown: () => Promise.resolve(),
    forceFlush: () => Promise.resolve()
  }
  const box = { last: null as string | null }
  const tracing = createOtlpTracingWith(
    new SimpleSpanProcessor(observeExports(backend, box)),
    { 'service.name': 'argus' },
    box
  )
  const sink = new OtlpSink(tracing, opts)
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
      const root = finished.find(
        (s) => isRoot(s) && s.spanContext().traceId === traceIdFromSeed(CONTRACT_SEED)
      )
      const rootId = root?.spanContext().spanId
      // §4.5: generation, tool and the `event <name>` span are children of the root.
      // Evaluation spans are children too, but the contract counts scores separately.
      const childrenOfRoot = finished.filter(
        (s) =>
          rootId != null &&
          s.parentSpanContext?.spanId === rootId &&
          s.attributes[S.ATTR_GEN_AI_OPERATION_NAME] !== S.OP_EVALUATION
      ).length
      return {
        roots: finished.filter(isRoot).length,
        childrenOfRoot,
        attempts,
        scoresForSeed: (seed) =>
          finished
            .filter((s) => s.spanContext().traceId === traceIdFromSeed(seed))
            .flatMap((s) => s.events)
            .filter((e) => e.name === S.EVENT_GEN_AI_EVALUATION_RESULT).length,
        containsText: (t) =>
          JSON.stringify(
            finished.map((s) => [s.name, s.attributes, s.events.map((e) => [e.name, e.attributes])])
          ).includes(t)
      }
    }
  }
}

describeSinkContract('OtlpSink', harness)
