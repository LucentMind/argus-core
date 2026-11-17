import { describe, it, expect } from 'vitest'
import {
  PROVIDER_DESCRIPTORS,
  OBSERVABILITY_PROVIDER_IDS,
  secretName,
  isProviderId,
  isObservabilitySecret,
  mlAppProblem,
  DATADOG_SITES,
  DEFAULT_DATADOG_ML_APP
} from '../observabilityProviders'

describe('observability provider descriptors', () => {
  it('lists datadog, langfuse and otlp (display order) with their fields', () => {
    expect(OBSERVABILITY_PROVIDER_IDS).toEqual(['datadog', 'langfuse', 'otlp'])
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
    expect(PROVIDER_DESCRIPTORS.datadog.fields.map((f) => `${f.kind}:${f.key}`)).toEqual([
      'select:site',
      'text:mlApp',
      'text:env',
      'secret:api-key'
    ])
    expect(PROVIDER_DESCRIPTORS.datadog.fields[0].options).toEqual(DATADOG_SITES)
    expect(DATADOG_SITES[0]).toBe('datadoghq.com')
    // The OTLP description no longer sends Datadog users through an Agent/Collector.
    expect(PROVIDER_DESCRIPTORS.otlp.description).not.toMatch(/Agent\/Collector/)
  })
  it('validates ml_app against Datadog naming rules', () => {
    expect(mlAppProblem(DEFAULT_DATADOG_ML_APP)).toBeNull()
    expect(mlAppProblem('team/argus:prod-1.2_x')).toBeNull()
    expect(mlAppProblem('Argus')).toMatch(/lowercase/)
    expect(mlAppProblem('argus app')).toMatch(/lowercase/)
    expect(mlAppProblem('ar__gus')).toMatch(/contiguous/)
    expect(mlAppProblem('argus_')).toMatch(/end with/)
    expect(mlAppProblem('a'.repeat(193))).toBeNull()
    expect(mlAppProblem('a'.repeat(194))).toMatch(/193/)
    expect(mlAppProblem('')).toMatch(/empty/)
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
    expect(isProviderId('datadog')).toBe(true)
    expect(isProviderId('honeycomb')).toBe(false)
  })
})
