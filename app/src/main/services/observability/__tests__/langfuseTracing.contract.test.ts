import { describe, it, expect, afterEach } from 'vitest'
import {
  NodeTracerProvider,
  InMemorySpanExporter,
  SimpleSpanProcessor
} from '@opentelemetry/sdk-trace-node'
import { setLangfuseTracerProvider, startObservation, createTraceId } from '@langfuse/tracing'
import { LangfuseOtelSpanAttributes } from '@langfuse/core'
import { synthSpanId } from '../langfuseSink'

/**
 * Exercises the real Langfuse tracing API against an in-memory OTel exporter,
 * bypassing LangfuseSpanProcessor (which would ship to a live server). Asserts
 * the attribute names v5 actually emits, so a future SDK rename fails loudly
 * here instead of silently dropping tokens and cost in production.
 */
function harness(): { exporter: InMemorySpanExporter; provider: NodeTracerProvider } {
  const exporter = new InMemorySpanExporter()
  const provider = new NodeTracerProvider({ spanProcessors: [new SimpleSpanProcessor(exporter)] })
  setLangfuseTracerProvider(provider)
  return { exporter, provider }
}

let active: NodeTracerProvider | null = null

afterEach(async () => {
  // setLangfuseTracerProvider is module-global inside @langfuse/tracing.
  // Leaving it set leaks into every later test in the process.
  setLangfuseTracerProvider(null)
  await active?.shutdown()
  active = null
})

describe('Langfuse v5 tracing contract', () => {
  it('emits usage and cost under usageDetails/costDetails, and inherits the parent trace id', async () => {
    const { exporter, provider } = harness()
    active = provider

    const seed = 'argus-session-7'
    const traceId = await createTraceId(seed)
    const parentSpanContext = { traceId, spanId: synthSpanId(seed), traceFlags: 1 }

    const root = startObservation(
      'auth-bug · session 7',
      { metadata: { caseId: 1 } },
      { parentSpanContext }
    )
    root.otelSpan.setAttribute(LangfuseOtelSpanAttributes.TRACE_NAME, 'auth-bug · session 7')
    root.end()
    const rootCtx = { traceId, spanId: root.otelSpan.spanContext().spanId, traceFlags: 1 }

    const start = new Date('2026-07-19T10:00:00.000Z')
    const end = new Date('2026-07-19T10:00:05.000Z')

    const gen = startObservation(
      'turn',
      {
        model: 'claude-opus-4-8',
        usageDetails: { input: 10, output: 5 },
        costDetails: { total: 0.01 }
      },
      { asType: 'generation', startTime: start, parentSpanContext: rootCtx }
    )
    gen.end(end)

    const tool = startObservation(
      'read_file',
      { level: 'DEFAULT' },
      { asType: 'tool', startTime: start, parentSpanContext: rootCtx }
    )
    tool.end(end)

    const spans = exporter.getFinishedSpans()
    expect(spans).toHaveLength(3)

    // Every span shares the deterministic trace id.
    expect(new Set(spans.map((s) => s.spanContext().traceId))).toEqual(new Set([traceId]))

    // The root must carry the trace-level name attribute. Naming the observation
    // alone leaves the trace unnamed — proven in Task 1, see EVIDENCE.md Q4.
    const rootSpan = spans.find((s) => s.name === 'auth-bug · session 7')
    expect(rootSpan!.attributes[LangfuseOtelSpanAttributes.TRACE_NAME]).toBe('auth-bug · session 7')

    const generation = spans.find((s) => s.name === 'turn')
    expect(generation).toBeDefined()
    const attrs = JSON.stringify(generation!.attributes)
    expect(attrs).toContain('usage_details')
    expect(attrs).toContain('cost_details')
    expect(attrs).toContain('claude-opus-4-8')

    // Explicit start/end produce a real duration, not an instant.
    const durationNs = generation!.duration[0] * 1e9 + generation!.duration[1]
    expect(durationNs).toBeGreaterThan(0)

    expect(spans.find((s) => s.name === 'read_file')).toBeDefined()
  })
})
