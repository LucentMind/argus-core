import { describe, it, expect } from 'vitest'
import {
  PROVIDER_DESCRIPTORS,
  OBSERVABILITY_PROVIDER_IDS,
  secretName,
  isProviderId,
  isObservabilitySecret
} from '../observabilityProviders'

describe('observability provider descriptors', () => {
  it('lists langfuse and otlp with their fields', () => {
    expect(OBSERVABILITY_PROVIDER_IDS).toEqual(['langfuse', 'otlp'])
    expect(PROVIDER_DESCRIPTORS.langfuse.fields.map((f) => `${f.kind}:${f.key}`)).toEqual([
      'text:host',
      'text:publicKey',
      'secret:secret-key'
    ])
    expect(PROVIDER_DESCRIPTORS.otlp.fields.map((f) => `${f.kind}:${f.key}`)).toEqual([
      'text:endpoint',
      'select:protocol',
      'secret:authorization'
    ])
    expect(PROVIDER_DESCRIPTORS.otlp.fields[1].options).toEqual(['http/protobuf', 'http/json'])
  })
  it('secret names keep the legacy Langfuse name', () => {
    expect(secretName('langfuse', 'secret-key')).toBe('observability/langfuse/secret-key')
    expect(secretName('otlp', 'authorization')).toBe('observability/otlp/authorization')
  })
  it('isObservabilitySecret matches every provider-scoped secret and nothing else', () => {
    expect(isObservabilitySecret(secretName('langfuse', 'secret-key'))).toBe(true)
    expect(isObservabilitySecret(secretName('otlp', 'authorization'))).toBe(true)
    expect(isObservabilitySecret('connector/jira/token')).toBe(false)
    expect(isObservabilitySecret('observability')).toBe(false)
    expect(isObservabilitySecret('x/observability/otlp/authorization')).toBe(false)
  })
  it('isProviderId narrows', () => {
    expect(isProviderId('otlp')).toBe(true)
    expect(isProviderId('datadog')).toBe(false)
  })
})
