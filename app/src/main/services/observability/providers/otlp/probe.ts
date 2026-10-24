import { ExportResultCode } from '@opentelemetry/core'
import {
  NodeTracerProvider,
  SimpleSpanProcessor,
  type SpanExporter
} from '@opentelemetry/sdk-trace-node'
import { resourceFromAttributes } from '@opentelemetry/resources'
import { ATTR_SERVICE_NAME } from '@opentelemetry/semantic-conventions'
import { createOtlpExporter, tracesUrl, type OtlpProtocol } from './tracing'

export type ExporterFactory = (cfg: {
  url: string
  protocol: OtlpProtocol
  headers: Record<string, string>
  timeoutMillis?: number
}) => SpanExporter

/** Bounds the probe on an unreachable host (the exporter's default is 10 s of retries). */
const PROBE_TIMEOUT_MS = 5000

/**
 * OTLP has no credential endpoint, so the health check is a real export: one
 * `argus.probe` span through a throw-away exporter (same protocol selection as the
 * sink), awaiting the export result callback. 401/404/connection-refused surface as
 * the exporter's FAILED error message.
 */
export async function probeOtlp(
  cfg: { endpoint: string; protocol: OtlpProtocol; authorization: string | null },
  factory: ExporterFactory = createOtlpExporter
): Promise<{ ok: boolean; detail: string }> {
  if (!cfg.endpoint) return { ok: false, detail: 'no endpoint configured' }
  const url = tracesUrl(cfg.endpoint)
  let provider: NodeTracerProvider | null = null
  try {
    const inner = factory({
      url,
      protocol: cfg.protocol,
      headers: cfg.authorization ? { Authorization: cfg.authorization } : {},
      timeoutMillis: PROBE_TIMEOUT_MS
    })
    let result: { ok: boolean; detail: string } | null = null
    const observing: SpanExporter = {
      export: (spans, cb) => {
        try {
          inner.export(spans, (r) => {
            result =
              r.code === ExportResultCode.SUCCESS
                ? { ok: true, detail: `exported ${spans.length} span to ${url}` }
                : { ok: false, detail: r.error?.message ?? 'export failed' }
            cb(r)
          })
        } catch (err) {
          const error = err instanceof Error ? err : new Error(String(err))
          result = { ok: false, detail: error.message }
          cb({ code: ExportResultCode.FAILED, error })
        }
      },
      shutdown: () => inner.shutdown(),
      forceFlush: () => inner.forceFlush?.() ?? Promise.resolve()
    }
    provider = new NodeTracerProvider({
      spanProcessors: [new SimpleSpanProcessor(observing)],
      resource: resourceFromAttributes({ [ATTR_SERVICE_NAME]: 'argus' })
    })
    provider.getTracer('argus').startSpan('argus.probe').end()
    await provider.forceFlush()
    return result ?? { ok: false, detail: 'exporter returned no result' }
  } catch (err) {
    return { ok: false, detail: err instanceof Error ? err.message : String(err) }
  } finally {
    await provider?.shutdown().catch(() => {})
  }
}
