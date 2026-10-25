import type { AppSettings } from '../../../shared/settings'
import {
  OBSERVABILITY_PROVIDER_IDS,
  type ObservabilityProviderId
} from '../../../shared/observabilityProviders'
import { ObservationExporter } from './exporter'
import { FanOutSink } from './fanOutSink'
import type { ObservationSink } from './sink'
import {
  OBSERVABILITY_PROVIDERS,
  type ObservabilityProvider,
  type SecretResolver
} from './providers'

export interface BuiltObservability {
  exporter: ObservationExporter | null
  /** Providers whose sink was built (enabled, complete, and `createSink` did not throw). */
  enabled: { id: ObservabilityProviderId; label: string }[]
  /** Every ENABLED provider — one health row each — complete or not, and whether or not its sink
   *  could be built: an incomplete one reports "not configured: missing <field>", a dead one (its
   *  `createSink` threw) reports the constructor error. A superset of `enabled`. */
  rows: { id: ObservabilityProviderId; label: string }[]
  /** Why a complete provider's sink could not be built (the `createSink` error message). */
  errors: Partial<Record<ObservabilityProviderId, string>>
  sinks: Partial<Record<ObservabilityProviderId, ObservationSink>>
}

/** The unknown keys last warned about; a rebuild with the same set stays quiet. */
let lastWarnedUnknown = ''

/** A passing probe says the endpoint is reachable now; the live sink may still have latched an
 *  ingestion failure (rejected export) — surface it rather than a bare green row. */
export function mergeProbeWithLastError(
  probe: { ok: boolean; detail: string },
  lastError: string | null | undefined
): { ok: boolean; detail: string } {
  return probe.ok && lastError
    ? { ok: true, detail: `${probe.detail} · last export error: ${lastError}` }
    : probe
}

/**
 * One provider's health check, in order: the sink could not even be constructed (say why, don't
 * probe) → a required field/secret is missing ("not configured: missing <field>", don't probe) →
 * probe (never throws: probes construct exporters too, so a hand-edited setting can make them
 * throw) merged with the live sink's latched export error.
 */
export async function checkObservabilityProvider(
  provider: Pick<ObservabilityProvider, 'missing' | 'probe'>,
  cfg: Record<string, unknown>,
  secret: SecretResolver,
  state: { buildError?: string; lastError?: () => string | null | undefined }
): Promise<{ ok: boolean; detail: string }> {
  if (state.buildError) return { ok: false, detail: state.buildError }
  const field = provider.missing(cfg, secret)
  if (field !== null) return { ok: false, detail: `not configured: missing ${field}` }
  try {
    const r = await provider.probe(cfg, secret)
    return mergeProbeWithLastError(r, state.lastError?.())
  } catch (err) {
    return { ok: false, detail: err instanceof Error ? err.message : String(err) }
  }
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
  const unknownKey = unknown.join(', ')
  if (unknownKey !== lastWarnedUnknown) {
    lastWarnedUnknown = unknownKey
    if (unknown.length > 0) {
      console.warn(`[observability] ignoring unknown provider settings: ${unknownKey}`)
    }
  }

  const enabled: BuiltObservability['enabled'] = []
  const rows: BuiltObservability['rows'] = []
  const errors: BuiltObservability['errors'] = {}
  const sinks: BuiltObservability['sinks'] = {}
  let captureContent = false
  for (const id of OBSERVABILITY_PROVIDER_IDS) {
    const cfg = providers[id]
    if (!cfg?.enabled) continue
    const provider = OBSERVABILITY_PROVIDERS[id]
    const cc = cfg.captureContent === true
    rows.push({ id, label: provider.descriptor.label })
    let sink: ObservationSink | null
    try {
      sink = provider.createSink(cfg, secret, {
        captureContent: cc,
        installId: ctx.installId,
        appVersion: ctx.appVersion
      })
    } catch (err) {
      // A hand-edited setting (malformed URL) makes the exporter constructors throw. Never let that
      // escape: it would skip the settings broadcast / starve the other providers.
      console.error(`[observability] ${id} sink not built`, err)
      errors[id] = err instanceof Error ? err.message : String(err)
      continue
    }
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
          captureContent,
          installId: ctx.installId
        })
  return { exporter, enabled, rows, errors, sinks }
}
