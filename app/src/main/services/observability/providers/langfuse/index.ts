import { PROVIDER_DESCRIPTORS, secretName } from '../../../../../shared/observabilityProviders'
import type { ObservabilityProvider } from '../types'
import { LangfuseSink } from './sink'
import { createLangfuseTracing } from './tracing'
import { probeLangfuseCredentials } from './probe'

const str = (v: unknown): string => (typeof v === 'string' ? v : '')
const SECRET = secretName('langfuse', 'secret-key')

function missing(
  cfg: Record<string, unknown>,
  secret: (name: string) => string | null
): string | null {
  if (!str(cfg.host)) return 'host'
  if (!str(cfg.publicKey)) return 'publicKey'
  if (!secret(SECRET)) return 'secret-key'
  return null
}

export const langfuseProvider: ObservabilityProvider = {
  descriptor: PROVIDER_DESCRIPTORS.langfuse,
  missing,
  createSink(cfg, secret, ctx) {
    if (missing(cfg, secret)) return null
    return new LangfuseSink(
      createLangfuseTracing({
        host: str(cfg.host),
        publicKey: str(cfg.publicKey),
        secretKey: secret(SECRET)!
      }),
      { captureContent: ctx.captureContent }
    )
  },
  probe: (cfg, secret) =>
    probeLangfuseCredentials({
      host: str(cfg.host),
      publicKey: str(cfg.publicKey),
      secretKey: secret(SECRET) ?? ''
    })
}
