import { describe, it, expect, vi, afterEach } from 'vitest'
import {
  buildObservationExporter,
  checkObservabilityProvider,
  mergeProbeWithLastError,
  type BuiltObservability
} from '../buildExporter'
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
  // Real sinks (BatchSpanProcessor / Langfuse global provider) are built here; shut them all down
  // so nothing leaks across tests.
  const built: BuiltObservability[] = []
  const build = (...a: Parameters<typeof buildObservationExporter>): BuiltObservability => {
    const r = buildObservationExporter(...a)
    built.push(r)
    return r
  }
  afterEach(async () => {
    vi.restoreAllMocks()
    for (const r of built.splice(0)) {
      await r.exporter?.shutdown()
      for (const sink of Object.values(r.sinks)) await sink?.shutdown()
    }
  })

  it('none enabled → null exporter, no enabled list', () => {
    const r = build(defaultSettings(), () => null, ctx)
    expect(r.exporter).toBeNull()
    expect(r.enabled).toEqual([])
  })

  it('enabled but incomplete (no secret) → null exporter, but still a health row', () => {
    const s = withProviders({
      langfuse: { enabled: true, host: 'https://lf', publicKey: 'pk', captureContent: false }
    })
    const r = build(s, () => null, ctx)
    expect(r.exporter).toBeNull()
    expect(r.enabled).toEqual([])
    // The row is what lets Test connection say "not configured: missing secret-key".
    expect(r.rows).toEqual([{ id: 'langfuse', label: 'Langfuse' }])
  })

  it('a disabled provider gets no row even when complete', () => {
    const s = withProviders({
      otlp: {
        enabled: false,
        endpoint: 'http://c:4318',
        protocol: 'http/protobuf',
        captureContent: false
      }
    })
    const r = build(s, () => null, ctx)
    expect(r.rows).toEqual([])
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
    const r = build(s, () => null, ctx) // otlp needs no secret
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
    const r = build(s, (n) => (n === 'observability/langfuse/secret-key' ? 'sk' : null), ctx)
    expect(r.enabled.map((e) => e.id)).toEqual(['langfuse', 'otlp'])
    expect(r.exporter!.sink).toBeInstanceOf(FanOutSink)
    expect(r.exporter!.opts.captureContent).toBe(true)
    expect(r.exporter!.opts.installId).toBe(ctx.installId) // the session seed is install-scoped
  })

  it('unknown keys under providers are ignored with one warning', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    const s = withProviders({ datadog: { enabled: true }, honeycomb: { enabled: true } })
    const r = build(s, () => null, ctx)
    expect(r.exporter).toBeNull()
    expect(r.enabled).toEqual([])
    expect(warn).toHaveBeenCalledTimes(1)
    expect(String(warn.mock.calls[0][0])).toContain('datadog')
    expect(String(warn.mock.calls[0][0])).toContain('honeycomb')
  })

  it('the unknown-key warning fires once per key set, not on every rebuild', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    const s = withProviders({ newrelic: { enabled: true } })
    build(s, () => null, ctx)
    build(s, () => null, ctx)
    expect(warn).toHaveBeenCalledTimes(1)
    build(
      withProviders({ newrelic: { enabled: true }, splunk: { enabled: true } }),
      () => null,
      ctx
    )
    expect(warn).toHaveBeenCalledTimes(2)
  })

  it('a throwing createSink yields no sink for that provider, never starves another', () => {
    const err = vi.spyOn(console, 'error').mockImplementation(() => {})
    const s = withProviders({
      langfuse: { enabled: true, host: 'https://lf', publicKey: 'pk', captureContent: false },
      otlp: {
        enabled: true,
        endpoint: 'not a url',
        protocol: 'http/protobuf',
        captureContent: false
      }
    })
    const r = build(s, (n) => (n === 'observability/langfuse/secret-key' ? 'sk' : null), ctx)
    expect(r.exporter).not.toBeNull()
    expect(r.enabled.map((e) => e.id)).toEqual(['langfuse'])
    expect(r.sinks.otlp).toBeUndefined()
    expect(r.rows.map((e) => e.id)).toEqual(['langfuse', 'otlp'])
    expect(r.errors.otlp).toMatch(/parse|URL/i)
    expect(r.errors.langfuse).toBeUndefined()
    expect(err).toHaveBeenCalledTimes(1)
  })

  it('complete + incomplete → only the complete one has a sink; both have rows', () => {
    const s = withProviders({
      langfuse: { enabled: true, host: 'https://lf', publicKey: 'pk', captureContent: false },
      otlp: { enabled: true, endpoint: '', protocol: 'http/protobuf', captureContent: false }
    })
    const r = build(s, (n) => (n === 'observability/langfuse/secret-key' ? 'sk' : null), ctx)
    expect(r.enabled.map((e) => e.id)).toEqual(['langfuse'])
    expect(r.rows.map((e) => e.id)).toEqual(['langfuse', 'otlp'])
    expect(r.sinks.otlp).toBeUndefined()
    expect(r.errors).toEqual({})
  })
})

describe('checkObservabilityProvider', () => {
  const okProbe = vi.fn(async () => ({ ok: true, detail: 'reachable' }))
  const provider = (
    missing: string | null,
    probe: Parameters<typeof checkObservabilityProvider>[0]['probe'] = okProbe
  ): Parameters<typeof checkObservabilityProvider>[0] => ({
    missing: () => missing,
    probe
  })
  afterEach(() => okProbe.mockClear())

  it('a build error wins and nothing is probed', async () => {
    const r = await checkObservabilityProvider(provider(null), {}, () => null, {
      buildError: 'Invalid URL'
    })
    expect(r).toEqual({ ok: false, detail: 'Invalid URL' })
    expect(okProbe).not.toHaveBeenCalled()
  })

  it('an incomplete provider fails with the missing field and is not probed', async () => {
    const r = await checkObservabilityProvider(provider('secret-key'), {}, () => null, {})
    expect(r).toEqual({ ok: false, detail: 'not configured: missing secret-key' })
    expect(okProbe).not.toHaveBeenCalled()
  })

  it('a complete provider is probed and the latched export error is merged', async () => {
    const r = await checkObservabilityProvider(provider(null), {}, () => null, {
      lastError: () => 'HTTP 401'
    })
    expect(r).toEqual({ ok: true, detail: 'reachable · last export error: HTTP 401' })
    expect(okProbe).toHaveBeenCalledTimes(1)
  })

  it('a throwing probe becomes a failed result', async () => {
    const r = await checkObservabilityProvider(
      provider(
        null,
        vi.fn(async () => Promise.reject(new Error('boom')))
      ),
      {},
      () => null,
      {}
    )
    expect(r).toEqual({ ok: false, detail: 'boom' })
  })
})

describe('mergeProbeWithLastError', () => {
  it('an ok probe with a latched error stays ok and appends the error', () => {
    expect(mergeProbeWithLastError({ ok: true, detail: 'reachable' }, 'HTTP 401')).toEqual({
      ok: true,
      detail: 'reachable · last export error: HTTP 401'
    })
  })
  it('otherwise the probe result is returned unchanged', () => {
    const ok = { ok: true, detail: 'reachable' }
    expect(mergeProbeWithLastError(ok, null)).toBe(ok)
    expect(mergeProbeWithLastError(ok, undefined)).toBe(ok)
    const bad = { ok: false, detail: 'refused' }
    expect(mergeProbeWithLastError(bad, 'HTTP 401')).toBe(bad)
  })
})
