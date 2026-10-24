import {
  NodeTracerProvider,
  BatchSpanProcessor,
  type ReadableSpan,
  type SpanExporter,
  type SpanProcessor
} from '@opentelemetry/sdk-trace-node'
import { resourceFromAttributes } from '@opentelemetry/resources'
import { ATTR_SERVICE_NAME, ATTR_SERVICE_VERSION } from '@opentelemetry/semantic-conventions'
import { OTLPTraceExporter as OTLPTraceExporterJson } from '@opentelemetry/exporter-trace-otlp-http'
import { OTLPTraceExporter as OTLPTraceExporterProto } from '@opentelemetry/exporter-trace-otlp-proto'
import { ExportResultCode, type ExportResult } from '@opentelemetry/core'
import type { Tracer } from '@opentelemetry/api'
import { ATTR_ARGUS_INSTALL_ID } from './semconv'

export type OtlpProtocol = 'http/protobuf' | 'http/json'

export interface OtlpTracing {
  tracer: Tracer
  forceFlush(): Promise<void>
  shutdown(): Promise<void>
  /** Last failed export, latched by `observeExports` (OTel reports failures via callback, never a throw). */
  lastExportError(): string | null
}

/** `<endpoint>/v1/traces`, appended only when the endpoint does not already end with it. */
export function tracesUrl(endpoint: string): string {
  const base = endpoint.replace(/\/+$/, '')
  return base.endsWith('/v1/traces') ? base : `${base}/v1/traces`
}

/**
 * The one place the `protocol` setting picks a wire format. In 0.220,
 * `exporter-trace-otlp-http` is JSON-only (it hardcodes the JSON serializer and
 * `Content-Type: application/json`) and protobuf lives in the sibling
 * `exporter-trace-otlp-proto` (hardcodes `application/x-protobuf`). Each class sets
 * its own Content-Type; we never set it by hand.
 */
export function createOtlpExporter(cfg: {
  url: string
  protocol: OtlpProtocol
  headers: Record<string, string>
}): SpanExporter {
  const opts = { url: cfg.url, headers: cfg.headers }
  return cfg.protocol === 'http/json'
    ? new OTLPTraceExporterJson(opts)
    : new OTLPTraceExporterProto(opts)
}

/**
 * Wraps any SpanExporter so a FAILED ExportResult is latched in `box`. Also logged
 * (once per distinct message): OTel's default error handler goes to the no-op `diag`
 * logger, so without this a rejected export leaves no trace anywhere.
 */
export function observeExports(inner: SpanExporter, box: { last: string | null }): SpanExporter {
  return {
    export: (spans: ReadableSpan[], cb: (r: ExportResult) => void) =>
      inner.export(spans, (r) => {
        if (r.code === ExportResultCode.FAILED) {
          const msg = r.error?.message ?? 'export failed'
          if (msg !== box.last) console.error('[observability] OTLP export failed', r.error ?? msg)
          box.last = msg
        }
        cb(r)
      }),
    shutdown: () => inner.shutdown(),
    forceFlush: () => inner.forceFlush?.() ?? Promise.resolve()
  }
}

/**
 * DI seam: builds the tracing around any processor. `box` is the error latch the
 * processor's exporter was wrapped with via `observeExports` (both factories use it).
 * Own provider, never registered globally — same isolation rationale as the Langfuse
 * adapter: a settings rebuild can tear it down without touching global OTel state.
 */
export function createOtlpTracingWith(
  processor: SpanProcessor,
  resourceAttrs: Record<string, string>,
  box: { last: string | null } = { last: null }
): OtlpTracing {
  const provider = new NodeTracerProvider({
    spanProcessors: [processor],
    resource: resourceFromAttributes(resourceAttrs)
  })
  return {
    tracer: provider.getTracer('argus'),
    forceFlush: () => provider.forceFlush(),
    shutdown: () => provider.shutdown(),
    lastExportError: () => box.last
  }
}

export function createOtlpTracing(cfg: {
  endpoint: string
  protocol: OtlpProtocol
  authorization: string | null
  serviceVersion: string
  installId: string
}): OtlpTracing {
  const box = { last: null as string | null }
  const exporter = createOtlpExporter({
    url: tracesUrl(cfg.endpoint),
    protocol: cfg.protocol,
    headers: cfg.authorization ? { Authorization: cfg.authorization } : {}
  })
  return createOtlpTracingWith(
    new BatchSpanProcessor(observeExports(exporter, box)),
    {
      // Explicit, or OTel's default resource leaks "unknown_service:<execPath>".
      [ATTR_SERVICE_NAME]: 'argus',
      [ATTR_SERVICE_VERSION]: cfg.serviceVersion,
      [ATTR_ARGUS_INSTALL_ID]: cfg.installId
    },
    box
  )
}
