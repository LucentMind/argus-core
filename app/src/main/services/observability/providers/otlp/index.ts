import { PROVIDER_DESCRIPTORS, secretName } from '../../../../../shared/observabilityProviders'
import type { ObservabilityProvider } from '../types'
import { OtlpSink } from './sink'
import { createOtlpTracing, type OtlpProtocol } from './tracing'
import { probeOtlp } from './probe'

const str = (v: unknown): string => (typeof v === 'string' ? v : '')
const SECRET = secretName('otlp', 'authorization')
// The settings schema constrains this to the two values; anything else (hand-edited file) falls
// back to the default rather than reaching the exporter factory.
const protocolOf = (v: unknown): OtlpProtocol => (v === 'http/json' ? 'http/json' : 'http/protobuf')

export const otlpProvider: ObservabilityProvider = {
  descriptor: PROVIDER_DESCRIPTORS.otlp,
  missing: (cfg) => (str(cfg.endpoint) ? null : 'endpoint'),
  createSink(cfg, secret, ctx) {
    if (!str(cfg.endpoint)) return null
    return new OtlpSink(
      createOtlpTracing({
        endpoint: str(cfg.endpoint),
        protocol: protocolOf(cfg.protocol),
        authorization: secret(SECRET),
        serviceVersion: ctx.appVersion,
        installId: ctx.installId
      }),
      { captureContent: ctx.captureContent }
    )
  },
  probe: (cfg, secret) =>
    probeOtlp({
      endpoint: str(cfg.endpoint),
      protocol: protocolOf(cfg.protocol),
      authorization: secret(SECRET)
    })
}
