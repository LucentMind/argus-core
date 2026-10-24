import type { AppSettings } from '../../../shared/settings'
import {
  OBSERVABILITY_PROVIDER_IDS,
  type ObservabilityProviderId
} from '../../../shared/observabilityProviders'
import { ObservationExporter } from './exporter'
import { FanOutSink } from './fanOutSink'
import type { ObservationSink } from './sink'
import { OBSERVABILITY_PROVIDERS } from './providers'

export interface BuiltObservability {
  exporter: ObservationExporter | null
  /** Providers that are enabled AND complete — one health row each. */
  enabled: { id: ObservabilityProviderId; label: string }[]
  sinks: Partial<Record<ObservabilityProviderId, ObservationSink>>
}

/**
 * Pure factory: settings + a secret resolver in, exporter out (no Electron, no globals).
 * A provider that is disabled, or enabled but missing a required field/secret, yields NO sink.
 * One sink → the exporter drives it directly; several → a `FanOutSink`. The reducer runs with
 * `captureContent` = OR over the enabled providers; each adapter strips content for itself when
 * its own flag is off. `secret` takes the FULL secret name (`secretName(id, key)`).
 */
export function buildObservationExporter(
  settings: AppSettings,
  secret: (name: string) => string | null,
  ctx: { installId: string; appVersion: string }
): BuiltObservability {
  const providers = (settings.observability?.providers ?? {}) as Record<
    string,
    Record<string, unknown> | undefined
  >
  const unknown = Object.keys(providers).filter(
    (k) => !(OBSERVABILITY_PROVIDER_IDS as readonly string[]).includes(k)
  )
  if (unknown.length > 0) {
    console.warn(`[observability] ignoring unknown provider settings: ${unknown.join(', ')}`)
  }

  const enabled: BuiltObservability['enabled'] = []
  const sinks: BuiltObservability['sinks'] = {}
  let captureContent = false
  for (const id of OBSERVABILITY_PROVIDER_IDS) {
    const cfg = providers[id]
    if (!cfg?.enabled) continue
    const provider = OBSERVABILITY_PROVIDERS[id]
    const cc = cfg.captureContent === true
    const sink = provider.createSink(cfg, secret, {
      captureContent: cc,
      installId: ctx.installId,
      appVersion: ctx.appVersion
    })
    if (!sink) continue
    sinks[id] = sink
    enabled.push({ id, label: provider.descriptor.label })
    captureContent ||= cc
  }

  const list = Object.values(sinks)
  const exporter =
    list.length === 0
      ? null
      : new ObservationExporter(list.length === 1 ? list[0] : new FanOutSink(list), {
          captureContent
        })
  return { exporter, enabled, sinks }
}
