import { describe, it, expect } from 'vitest'
import {
  InMemorySpanExporter,
  SimpleSpanProcessor,
  type ReadableSpan,
  type SpanExporter
} from '@opentelemetry/sdk-trace-node'
import { SpanKind, SpanStatusCode } from '@opentelemetry/api'
import { ExportResultCode } from '@opentelemetry/core'
import { createTraceId } from '@langfuse/tracing'
import { OtlpSink, traceIdFromSeed, spanIdFromSeed } from '../sink'
import { createOtlpTracingWith, observeExports, tracesUrl } from '../tracing'
import * as S from '../semconv'
import { synthSpanId } from '../../langfuse/sink'
import { CONTRACT_SCRIPT, CONTRACT_SEED } from '../../__tests__/sinkContract'
import type { ObservationIntent } from '../../../intent'

function harness(captureContent = true): {
  exporter: InMemorySpanExporter
  sink: OtlpSink
  spans: () => ReadableSpan[]
} {
  const exporter = new InMemorySpanExporter()
  // InMemorySpanExporter.shutdown() clears its buffer; roots export only at sink
  // shutdown, so keep the buffer readable after it.
  const keep: SpanExporter = {
    export: (spans, cb) => exporter.export(spans, cb),
    shutdown: async () => {},
    forceFlush: () => exporter.forceFlush()
  }
  const tracing = createOtlpTracingWith(new SimpleSpanProcessor(keep), {
    'service.name': 'argus',
    [S.ATTR_ARGUS_INSTALL_ID]: 'inst-1'
  })
  const sink = new OtlpSink(tracing, { captureContent })
  return { exporter, sink, spans: () => exporter.getFinishedSpans() }
}

const ms = (t: [number, number]): number => t[0] * 1e3 + t[1] / 1e6
const byOp = (spans: ReadableSpan[], op: string): ReadableSpan | undefined =>
  spans.find((s) => s.attributes[S.ATTR_GEN_AI_OPERATION_NAME] === op)

describe('OtlpSink', () => {
  it('maps the contract script to GenAI-convention spans and events', async () => {
    const h = harness()
    h.sink.emit(CONTRACT_SCRIPT)
    // The root stays open (it carries the event/score span events) until shutdown.
    await h.sink.shutdown()
    const spans = h.spans()

    const root = byOp(spans, S.OP_INVOKE_AGENT)!
    expect(root.name).toBe('invoke_agent case-x · session 77')
    expect(root.kind).toBe(SpanKind.CLIENT)
    expect(root.attributes[S.ATTR_GEN_AI_CONVERSATION_ID]).toBe('case-x')
    expect(root.attributes[S.ATTR_GEN_AI_AGENT_NAME]).toBe('argus')
    expect(root.attributes[S.ATTR_ARGUS_CASE_SLUG]).toBe('case-x')
    expect(root.attributes['argus.caseId']).toBe(1)
    expect(root.spanContext().traceId).toBe(traceIdFromSeed(CONTRACT_SEED))
    // The root hangs off the same synthetic parent the Langfuse sink uses.
    expect(root.parentSpanContext?.spanId).toBe(synthSpanId(CONTRACT_SEED))
    expect(root.resource.attributes['service.name']).toBe('argus')
    expect(root.resource.attributes[S.ATTR_ARGUS_INSTALL_ID]).toBe('inst-1')

    const chat = byOp(spans, S.OP_CHAT)!
    expect(chat.name).toBe('chat claude-sonnet-5')
    expect(chat.attributes[S.ATTR_GEN_AI_REQUEST_MODEL]).toBe('claude-sonnet-5')
    expect(chat.attributes[S.ATTR_GEN_AI_USAGE_INPUT_TOKENS]).toBe(10)
    expect(chat.attributes[S.ATTR_GEN_AI_USAGE_OUTPUT_TOKENS]).toBe(5)
    expect(chat.attributes[S.ATTR_ARGUS_COST_USD]).toBe(0.01)
    expect(chat.parentSpanContext?.spanId).toBe(root.spanContext().spanId)
    expect(chat.spanContext().traceId).toBe(root.spanContext().traceId)
    expect(ms(chat.startTime)).toBeCloseTo(1000, 0)
    expect(ms(chat.endTime)).toBeCloseTo(2000, 0)
    expect(chat.events.map((e) => e.name)).toEqual([
      S.ATTR_GEN_AI_INPUT_MESSAGES,
      S.ATTR_GEN_AI_OUTPUT_MESSAGES
    ])
    expect(JSON.stringify(chat.events)).toContain('CONTENT-IN')
    expect(JSON.stringify(chat.events)).toContain('CONTENT-OUT')

    const tool = byOp(spans, S.OP_EXECUTE_TOOL)!
    expect(tool.name).toBe('execute_tool read_file')
    expect(tool.attributes[S.ATTR_GEN_AI_TOOL_NAME]).toBe('read_file')
    expect(tool.attributes[S.ATTR_GEN_AI_TOOL_CALL_RESULT]).toBe('CONTENT-TOOL')
    expect(tool.status.code).toBe(SpanStatusCode.UNSET)
    expect(tool.parentSpanContext?.spanId).toBe(root.spanContext().spanId)
    expect(ms(tool.startTime)).toBeCloseTo(1100, 0)
    expect(ms(tool.endTime)).toBeCloseTo(1200, 0)

    const ev = root.events.find((e) => e.name === 'session resumed')!
    expect(ev).toBeDefined()
    expect(ev.attributes?.[S.ATTR_ARGUS_LEVEL]).toBe('DEFAULT')
    const scoreEv = root.events.find((e) => e.name === S.EVENT_GEN_AI_EVALUATION_RESULT)!
    expect(scoreEv.attributes?.[S.ATTR_GEN_AI_EVALUATION_NAME]).toBe('hitl_approved')
    expect(scoreEv.attributes?.[S.ATTR_GEN_AI_EVALUATION_SCORE_VALUE]).toBe(1)

    // argus-session-78 has no live root → one short evaluation span, nothing more.
    const evalSpan = spans.find((s) => s.name === 'evaluation finding_accepted')!
    expect(evalSpan.spanContext().traceId).toBe(traceIdFromSeed('argus-session-78'))
    expect(spans).toHaveLength(4)
  })

  it('exports children on flush while the root stays open until shutdown', async () => {
    const h = harness()
    h.sink.emit(CONTRACT_SCRIPT.slice(0, 3))
    await h.sink.flush()
    expect(
      h
        .spans()
        .map((s) => s.attributes[S.ATTR_GEN_AI_OPERATION_NAME])
        .sort()
    ).toEqual([S.OP_CHAT, S.OP_EXECUTE_TOOL])
    await h.sink.shutdown()
    expect(byOp(h.spans(), S.OP_INVOKE_AGENT)).toBeDefined()
  })

  it('a duplicate trace-root reuses the cached root', async () => {
    const h = harness()
    h.sink.emit([CONTRACT_SCRIPT[0], CONTRACT_SCRIPT[0]])
    await h.sink.shutdown()
    expect(
      h.spans().filter((s) => s.attributes[S.ATTR_GEN_AI_OPERATION_NAME] === S.OP_INVOKE_AGENT)
    ).toHaveLength(1)
  })

  it('a score with no live root opens a short evaluation span in the seed-derived trace', async () => {
    const h = harness()
    h.sink.emit([
      {
        kind: 'score',
        seed: 'argus-session-78',
        name: 'finding_accepted',
        value: 0,
        comment: 'looks right',
        id: 'abc',
        metadata: { 'argus.case.slug': 'c2', nested: { a: 1 }, gone: null }
      }
    ])
    await h.sink.flush()
    const [span] = h.spans()
    expect(span.name).toBe('evaluation finding_accepted')
    expect(span.attributes[S.ATTR_GEN_AI_OPERATION_NAME]).toBe(S.OP_EVALUATION)
    expect(span.spanContext().traceId).toBe(traceIdFromSeed('argus-session-78'))
    expect(span.parentSpanContext?.spanId).toBe(synthSpanId('argus-session-78'))
    const ev = span.events[0]
    expect(ev.name).toBe(S.EVENT_GEN_AI_EVALUATION_RESULT)
    expect(ev.attributes?.[S.ATTR_GEN_AI_EVALUATION_NAME]).toBe('finding_accepted')
    expect(ev.attributes?.[S.ATTR_GEN_AI_EVALUATION_SCORE_VALUE]).toBe(0)
    expect(ev.attributes?.[S.ATTR_GEN_AI_EVALUATION_EXPLANATION]).toBe('looks right')
    expect(ev.attributes?.[S.ATTR_ARGUS_SCORE_ID]).toBe('abc')
    // Metadata keys land verbatim; non-primitives are JSON-encoded, nullish dropped.
    expect(ev.attributes?.['argus.case.slug']).toBe('c2')
    expect(ev.attributes?.nested).toBe('{"a":1}')
    expect(ev.attributes && 'gone' in ev.attributes).toBe(false)
  })

  it('rootless generation/tool/event attach to the synthetic parent without a placeholder root', async () => {
    const h = harness()
    const seed = 'argus-session-90'
    const intents: ObservationIntent[] = [
      { kind: 'generation', seed, name: 'turn', model: 'm', startTime: 5000, endTime: 6000 },
      { kind: 'tool', seed, name: 'grep', isError: false },
      { kind: 'event', seed, name: 'session resumed', level: 'ERROR', metadata: { why: 'x' } }
    ]
    h.sink.emit(intents)
    await h.sink.flush()
    const spans = h.spans()
    expect(spans).toHaveLength(3)
    expect(byOp(spans, S.OP_INVOKE_AGENT)).toBeUndefined()
    for (const s of spans) {
      expect(s.spanContext().traceId).toBe(traceIdFromSeed(seed))
      expect(s.parentSpanContext?.spanId).toBe(synthSpanId(seed))
    }
    const evSpan = spans.find((s) => s.name === 'event session resumed')!
    expect(evSpan.events[0].name).toBe('session resumed')
    expect(evSpan.events[0].attributes?.[S.ATTR_ARGUS_LEVEL]).toBe('ERROR')
    expect(evSpan.events[0].attributes?.why).toBe('x')

    // A later trace-root for the same seed still creates the real root (the synthetic
    // path never populated the root cache).
    h.sink.emit([{ kind: 'trace-root', seed, name: 'c · s', caseSlug: 'c', metadata: {} }])
    await h.sink.shutdown()
    expect(byOp(h.spans(), S.OP_INVOKE_AGENT)?.spanContext().traceId).toBe(traceIdFromSeed(seed))
  })

  it('a tool error sets ERROR status; captureContent=false emits no message events or output', async () => {
    const h = harness(false)
    h.sink.emit([
      CONTRACT_SCRIPT[0],
      { ...CONTRACT_SCRIPT[2], isError: true } as ObservationIntent,
      CONTRACT_SCRIPT[1]
    ])
    await h.sink.shutdown()
    const spans = h.spans()
    const tool = byOp(spans, S.OP_EXECUTE_TOOL)!
    expect(tool.status.code).toBe(SpanStatusCode.ERROR)
    expect(tool.attributes[S.ATTR_GEN_AI_TOOL_CALL_RESULT]).toBeUndefined()
    expect(byOp(spans, S.OP_CHAT)!.events).toEqual([])
    expect(JSON.stringify(spans.map((s) => [s.attributes, s.events]))).not.toMatch(/CONTENT-/)
  })

  it('latches a FAILED export into lastError (OTel reports it via callback, never a throw)', async () => {
    const box = { last: null as string | null }
    const failing = observeExports(
      {
        export: (_s, cb) => cb({ code: ExportResultCode.FAILED, error: new Error('503 down') }),
        shutdown: async () => {},
        forceFlush: async () => {}
      },
      box
    )
    const sink = new OtlpSink(
      createOtlpTracingWith(new SimpleSpanProcessor(failing), { 'service.name': 'argus' }, box),
      { captureContent: true }
    )
    expect(sink.lastError()).toBeNull()
    sink.emit([CONTRACT_SCRIPT[1]])
    await sink.flush()
    expect(sink.lastError()).toBe('503 down')
  })

  it('traceIdFromSeed is 32 lowercase hex, deterministic, never all zeros, and equals the Langfuse derivation', async () => {
    expect(traceIdFromSeed('x')).toMatch(/^[0-9a-f]{32}$/)
    expect(traceIdFromSeed('x')).toBe(traceIdFromSeed('x'))
    expect(traceIdFromSeed('x')).not.toBe(traceIdFromSeed('y'))
    // Same trace id the Langfuse sink derives for the same seed (createTraceId(seed)).
    expect(traceIdFromSeed(CONTRACT_SEED)).toBe(await createTraceId(CONTRACT_SEED))
    expect(spanIdFromSeed(CONTRACT_SEED)).toBe(synthSpanId(CONTRACT_SEED))
  })

  it('tracesUrl appends /v1/traces once', () => {
    expect(tracesUrl('http://x:4318')).toBe('http://x:4318/v1/traces')
    expect(tracesUrl('http://x:4318/')).toBe('http://x:4318/v1/traces')
    expect(tracesUrl('http://x:4318/v1/traces')).toBe('http://x:4318/v1/traces')
  })
})
