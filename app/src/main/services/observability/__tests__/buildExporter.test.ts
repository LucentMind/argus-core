import { describe, it, expect, vi, afterEach } from 'vitest'
import { buildObservationExporter } from '../buildExporter'
import { defaultSettings } from '../../../../shared/settings'
import type { AppSettings } from '../../../../shared/settings'
import { FanOutSink } from '../fanOutSink'

const ctx = { installId: 'i', appVersion: '1.0.0' }
const withProviders = (p: Record<string, unknown>): AppSettings => {
  const base = defaultSettings()
  return {
    ...base,
    observability: {
      ...base.observability,
      providers: { ...base.observability.providers, ...p }
    }
  } as AppSettings
}

describe('buildObservationExporter', () => {
  afterEach(() => vi.restoreAllMocks())

  it('none enabled → null exporter, no enabled list', () => {
    const r = buildObservationExporter(defaultSettings(), () => null, ctx)
    expect(r.exporter).toBeNull()
    expect(r.enabled).toEqual([])
  })

  it('enabled but incomplete (no secret) → null exporter', () => {
    const s = withProviders({
      langfuse: { enabled: true, host: 'https://lf', publicKey: 'pk', captureContent: false }
    })
    const r = buildObservationExporter(s, () => null, ctx)
    expect(r.exporter).toBeNull()
    expect(r.enabled).toEqual([])
  })

  it('one complete provider → exporter over that provider’s sink', () => {
    const s = withProviders({
      otlp: {
        enabled: true,
        endpoint: 'http://c:4318',
        protocol: 'http/protobuf',
        captureContent: false
      }
    })
    const r = buildObservationExporter(s, () => null, ctx) // otlp needs no secret
    expect(r.exporter).not.toBeNull()
    expect(r.enabled).toEqual([{ id: 'otlp', label: 'OpenTelemetry (OTLP/HTTP)' }])
    expect(r.sinks.otlp).toBeDefined()
    expect(r.sinks.langfuse).toBeUndefined()
    expect(r.exporter!.sink).toBe(r.sinks.otlp)
  })

  it('two complete providers → FanOutSink; captureContent is the union', () => {
    const s = withProviders({
      langfuse: { enabled: true, host: 'https://lf', publicKey: 'pk', captureContent: true },
      otlp: {
        enabled: true,
        endpoint: 'http://c:4318',
        protocol: 'http/protobuf',
        captureContent: false
      }
    })
    const r = buildObservationExporter(
      s,
      (n) => (n === 'observability/langfuse/secret-key' ? 'sk' : null),
      ctx
    )
    expect(r.enabled.map((e) => e.id)).toEqual(['langfuse', 'otlp'])
    expect(r.exporter!.sink).toBeInstanceOf(FanOutSink)
    expect(r.exporter!.opts.captureContent).toBe(true)
  })

  it('unknown keys under providers are ignored with one warning', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    const s = withProviders({ datadog: { enabled: true }, honeycomb: { enabled: true } })
    const r = buildObservationExporter(s, () => null, ctx)
    expect(r.exporter).toBeNull()
    expect(r.enabled).toEqual([])
    expect(warn).toHaveBeenCalledTimes(1)
    expect(String(warn.mock.calls[0][0])).toContain('datadog')
    expect(String(warn.mock.calls[0][0])).toContain('honeycomb')
  })
})
