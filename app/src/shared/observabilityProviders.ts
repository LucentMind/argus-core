/** Observability providers as the RENDERER and MAIN both see them: ids, labels and the fields a
 *  settings page renders. Construction and probing live in main (providers/index.ts); this file
 *  must stay free of main imports. */
export type ObservabilityProviderId = 'langfuse' | 'otlp' | 'datadog'
/** Registry order is display order (Settings sections, health rows): Datadog first, as the
 *  provider the org standardizes on. */
export const OBSERVABILITY_PROVIDER_IDS: readonly ObservabilityProviderId[] = [
  'datadog',
  'langfuse',
  'otlp'
]

/** Datadog sites that host LLM Observability (the US1-FED / gov sites do not). The first is the
 *  default. Each maps to the intake host `api.<site>`. */
export const DATADOG_SITES = [
  'datadoghq.com',
  'us3.datadoghq.com',
  'us5.datadoghq.com',
  'datadoghq.eu',
  'ap1.datadoghq.com',
  'ap2.datadoghq.com'
] as const
export type DatadogSite = (typeof DATADOG_SITES)[number]

/** The `ml_app` used when the setting is blank. */
export const DEFAULT_DATADOG_ML_APP = 'argus'

/**
 * Datadog's LLM Observability application naming rule: lowercase, only alphanumerics and
 * `_ - : . /`, at most 193 characters, no contiguous or trailing underscores. Returns why a name
 * is invalid, or null when it is valid.
 */
export function mlAppProblem(name: string): string | null {
  if (name.length === 0) return 'ml_app is empty'
  if (name.length > 193) return 'ml_app is longer than 193 characters'
  if (!/^[a-z0-9_\-:./]+$/.test(name))
    return 'ml_app may only contain lowercase letters, digits and _ - : . /'
  if (name.includes('__')) return 'ml_app may not contain contiguous underscores'
  if (name.endsWith('_')) return 'ml_app may not end with an underscore'
  return null
}

export type ProviderFieldKind = 'text' | 'secret' | 'select'
export interface ProviderField {
  /** Settings key under `observability.providers.<id>` (text/select) or the secret-name suffix (secret). */
  key: string
  label: string
  kind: ProviderFieldKind
  placeholder?: string
  options?: readonly string[]
  required?: boolean
  /** Render with a monospace field (urls, keys). */
  mono?: boolean
}
export interface ProviderDescriptor {
  id: ObservabilityProviderId
  label: string
  description: string
  fields: readonly ProviderField[]
}

export const PROVIDER_DESCRIPTORS: Record<ObservabilityProviderId, ProviderDescriptor> = {
  langfuse: {
    id: 'langfuse',
    label: 'Langfuse',
    description:
      'Send agent traces, cost, latency and evaluation scores to a Langfuse instance (cloud or self-hosted).',
    fields: [
      {
        key: 'host',
        label: 'Host URL',
        kind: 'text',
        placeholder: 'https://cloud.langfuse.com',
        required: true,
        mono: true
      },
      {
        key: 'publicKey',
        label: 'Public key',
        kind: 'text',
        placeholder: 'pk-lf-…',
        required: true,
        mono: true
      },
      {
        key: 'secret-key',
        label: 'Secret key',
        kind: 'secret',
        placeholder: 'sk-lf-…',
        required: true
      }
    ]
  },
  otlp: {
    id: 'otlp',
    label: 'OpenTelemetry (OTLP/HTTP)',
    description:
      'Send traces in the OpenTelemetry GenAI conventions to any OTLP/HTTP collector (OpenTelemetry Collector, Grafana, Langfuse’s OTLP endpoint). For Datadog, use the Datadog provider.',
    fields: [
      {
        key: 'endpoint',
        label: 'Endpoint',
        kind: 'text',
        placeholder: 'http://localhost:4318',
        required: true,
        mono: true
      },
      {
        key: 'protocol',
        label: 'Protocol',
        kind: 'select',
        options: ['http/protobuf', 'http/json']
      },
      {
        key: 'authorization',
        label: 'Authorization header',
        kind: 'secret',
        placeholder: 'Bearer … (optional)'
      }
    ]
  },
  datadog: {
    id: 'datadog',
    label: 'Datadog LLM Observability',
    description:
      'Send agent traces, token usage, cost and evaluation scores straight to Datadog LLM Observability (no Agent or Collector needed).',
    fields: [
      {
        key: 'site',
        label: 'Site',
        kind: 'select',
        options: DATADOG_SITES
      },
      {
        key: 'mlApp',
        label: 'ML app',
        kind: 'text',
        placeholder: DEFAULT_DATADOG_ML_APP,
        mono: true
      },
      {
        key: 'env',
        label: 'Environment',
        kind: 'text',
        placeholder: 'optional, e.g. prod',
        mono: true
      },
      {
        key: 'api-key',
        label: 'API key',
        kind: 'secret',
        placeholder: 'Datadog API key',
        required: true
      }
    ]
  }
}

export function secretName(id: ObservabilityProviderId, key: string): string {
  return `observability/${id}/${key}`
}

/** True for any secret a provider's sink reads (`secretName(<id>, <key>)`): saving or deleting one
 *  must rebuild the exporter, since sinks read their secrets once, at construction. */
export function isObservabilitySecret(name: string): boolean {
  return name.startsWith('observability/')
}

export function isProviderId(v: unknown): v is ObservabilityProviderId {
  return typeof v === 'string' && (OBSERVABILITY_PROVIDER_IDS as readonly string[]).includes(v)
}
