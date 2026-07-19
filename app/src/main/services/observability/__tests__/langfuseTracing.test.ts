import { describe, it, expect, afterEach } from 'vitest'
import {
  setLangfuseTracerProvider,
  getLangfuseTracerProvider,
  createTraceId,
  startObservation
} from '@langfuse/tracing'
import { ATTR_SERVICE_NAME } from '@opentelemetry/semantic-conventions'
import { createLangfuseTracing } from '../langfuseTracing'
import { synthSpanId } from '../langfuseSink'

/**
 * Regression coverage for the rebuild-ordering bug: a settings-change rebuild calls
 * `old.shutdown()` without awaiting it, then synchronously builds a new tracing
 * instance. `old.shutdown()`'s `provider.shutdown()` runs to its first await and
 * yields — the new instance installs itself as the module-global tracer provider
 * before the old shutdown resumes and reaches `setLangfuseTracerProvider(null)`.
 * Clearing unconditionally there wipes out the live (new) provider, silently
 * disabling telemetry for the rest of the session. See langfuseTracing.ts's
 * shutdown() for the identity guard this test protects.
 */

const cfg = { host: 'https://example.test', publicKey: 'pk', secretKey: 'sk' }

afterEach(() => {
  // setLangfuseTracerProvider is module-global inside @langfuse/tracing; reset it
  // so this file cannot leak state into other tests in the process.
  setLangfuseTracerProvider(null)
})

describe('createLangfuseTracing shutdown ordering', () => {
  it('a stale instance finishing shutdown after a rebuild does not clear the new provider', async () => {
    const a = createLangfuseTracing(cfg) // pre-rebuild tracer
    const b = createLangfuseTracing(cfg) // simulates a synchronous settings-change rebuild

    // B installed itself as the module-global tracer provider when it was constructed.
    const providerB = getLangfuseTracerProvider()

    // A finishing shutdown late (as happens in production once its suspended
    // provider.shutdown() resumes after B has already taken over) must not clear
    // B's provider — that is exactly the bug Fix 1 guards against.
    await a.shutdown()
    expect(getLangfuseTracerProvider()).toBe(providerB)

    // B is still the owner and still live; shutting it down for real now DOES clear
    // the slot (next test / next block below covers this explicitly too).
    await b.shutdown()
    expect(getLangfuseTracerProvider()).not.toBe(providerB)
  })

  it('the owning instance shutting down clears the module-global slot', async () => {
    const solo = createLangfuseTracing(cfg)
    const providerSolo = getLangfuseTracerProvider()
    expect(providerSolo).toBeDefined()

    await solo.shutdown()

    // Once cleared, getLangfuseTracerProvider() falls back to the OTel default —
    // a different object from the isolated provider that was just torn down.
    expect(getLangfuseTracerProvider()).not.toBe(providerSolo)
  })
})

describe('createLangfuseTracing resource attributes', () => {
  afterEach(() => {
    setLangfuseTracerProvider(null)
  })

  it('sets service.name to argus instead of the OTel default (which embeds the local exe path)', async () => {
    // Every trace's resourceAttributes.service.name defaulted to
    // "unknown_service:C:\...\argus.exe" — OTel's default when no service name
    // is set on the NodeTracerProvider's resource. That leaked the local
    // filesystem path into every trace shipped to Langfuse.
    createLangfuseTracing(cfg)

    const seed = 'argus-session-resource-test'
    const traceId = await createTraceId(seed)
    const span = startObservation(
      'probe',
      {},
      { parentSpanContext: { traceId, spanId: synthSpanId(seed), traceFlags: 1 } }
    )
    span.end()

    const resourceAttrs = (
      span.otelSpan as unknown as { resource: { attributes: Record<string, unknown> } }
    ).resource.attributes
    expect(resourceAttrs[ATTR_SERVICE_NAME]).toBe('argus')
  })
})
