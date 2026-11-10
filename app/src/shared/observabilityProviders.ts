/** Observability providers as the RENDERER and MAIN both see them: ids, labels and the fields a
 *  settings page renders. Construction and probing live in main (providers/index.ts); this file
 *  must stay free of main imports. */
export type ObservabilityProviderId = 'langfuse' | 'otlp'
export const OBSERVABILITY_PROVIDER_IDS: readonly ObservabilityProviderId[] = ['langfuse', 'otlp']

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
      'Send traces in the OpenTelemetry GenAI conventions to any OTLP/HTTP collector (OpenTelemetry Collector, Grafana, Langfuse’s OTLP endpoint; Datadog via its Agent/Collector).',
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
