import { NodeTracerProvider } from '@opentelemetry/sdk-trace-node'
import { LangfuseSpanProcessor } from '@langfuse/otel'
import { LangfuseOtelSpanAttributes } from '@langfuse/core'
import { LangfuseClient } from '@langfuse/client'
import { createTraceId, startObservation, setLangfuseTracerProvider } from '@langfuse/tracing'
import type { ObservationHandle, StartOpts, TracingApi } from './langfuseSink'

/**
 * The only file in the codebase that imports Langfuse or OpenTelemetry.
 *
 * Uses an isolated NodeTracerProvider via setLangfuseTracerProvider rather than
 * registering globally, so the rebuild-on-settings-change path can tear the
 * whole thing down and stand a new one up without touching global OTel state.
 */
export function createLangfuseTracing(cfg: {
  host: string
  publicKey: string
  secretKey: string
}): TracingApi {
  const processor = new LangfuseSpanProcessor({
    publicKey: cfg.publicKey,
    secretKey: cfg.secretKey,
    baseUrl: cfg.host
  })
  const provider = new NodeTracerProvider({ spanProcessors: [processor] })
  setLangfuseTracerProvider(provider)

  const client = new LangfuseClient({
    publicKey: cfg.publicKey,
    secretKey: cfg.secretKey,
    baseUrl: cfg.host
  })

  return {
    createTraceId: (seed) => createTraceId(seed),

    startObservation: (name, attributes, opts: StartOpts): ObservationHandle => {
      const span = startObservation(
        name,
        attributes as never,
        {
          ...(opts.asType ? { asType: opts.asType } : {}),
          ...(opts.startTime != null ? { startTime: new Date(opts.startTime) } : {}),
          parentSpanContext: opts.parentSpanContext
        } as never
      )

      // Trace-level attributes are NOT set by naming an observation — they must be
      // written onto the underlying OTel span. Proven in Task 1; see EVIDENCE.md Q4.
      if (opts.traceName != null) {
        span.otelSpan.setAttribute(LangfuseOtelSpanAttributes.TRACE_NAME, opts.traceName)
      }
      for (const [k, v] of Object.entries(opts.traceMetadata ?? {})) {
        span.otelSpan.setAttribute(
          `${LangfuseOtelSpanAttributes.TRACE_METADATA}.${k}`,
          typeof v === 'string' ? v : JSON.stringify(v)
        )
      }

      return {
        spanId: span.otelSpan.spanContext().spanId,
        end: (endTime?: number) => span.end(endTime != null ? new Date(endTime) : undefined)
      }
    },

    createScore: async (o) => {
      await client.score.create({
        traceId: o.traceId,
        name: o.name,
        value: o.value,
        ...(o.comment != null ? { comment: o.comment } : {})
      })
    },

    forceFlush: () => processor.forceFlush(),

    shutdown: async () => {
      await provider.shutdown()
      setLangfuseTracerProvider(null)
    }
  }
}
