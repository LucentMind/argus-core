import { Langfuse } from 'langfuse'
import type { LangfuseClientLike } from './langfuse'

/**
 * Adapts the real `langfuse` SDK client (v3, classic REST client — `new Langfuse(...)`
 * with instance methods `.trace()/.span()/.generation()/.score()/.flushAsync()/.shutdownAsync()`)
 * to the minimal `LangfuseClientLike` surface consumed by `LangfuseExporter`.
 *
 * This file is the single point of coupling to the SDK; if the installed version's
 * method names/signatures change, adapt here only.
 */
export function buildLangfuseClient(cfg: {
  host: string
  publicKey: string
  secretKey: string
}): LangfuseClientLike {
  const lf = new Langfuse({ baseUrl: cfg.host, publicKey: cfg.publicKey, secretKey: cfg.secretKey })
  return {
    trace: (o) => lf.trace(o),
    generation: (o) => {
      lf.generation(o as never)
    },
    span: (o) => {
      lf.span(o as never)
    },
    score: (o) => {
      lf.score(o as never)
    },
    flushAsync: () => lf.flushAsync(),
    shutdownAsync: () => lf.shutdownAsync()
  }
}
