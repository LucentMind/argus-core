import { describe, it, expect } from 'vitest'
import {
  PROVIDER_DESCRIPTORS,
  OBSERVABILITY_PROVIDER_IDS,
  secretName,
  isProviderId
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
  it('isProviderId narrows', () => {
    expect(isProviderId('otlp')).toBe(true)
    expect(isProviderId('datadog')).toBe(false)
  })
})
