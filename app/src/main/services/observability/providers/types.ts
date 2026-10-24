import type { ProviderDescriptor } from '../../../../shared/observabilityProviders'
import type { ObservationSink } from '../sink'

/** Resolves a secret by its FULL store name (`secretName(id, key)`); null when absent. */
export type SecretResolver = (name: string) => string | null

/** One observability backend as main sees it: how to build its sink, probe it, and tell what is
 *  missing. Kept in its own module so the provider files can import the type without a cycle
 *  through `providers/index.ts`. */
export interface ObservabilityProvider {
  descriptor: ProviderDescriptor
  /** null when a required text field or secret is missing. */
  createSink(
    cfg: Record<string, unknown>,
    secret: SecretResolver,
    ctx: { captureContent: boolean; installId: string; appVersion: string }
  ): ObservationSink | null
  probe(
    cfg: Record<string, unknown>,
    secret: SecretResolver
  ): Promise<{ ok: boolean; detail: string }>
  /** Which required field is missing, for the health row detail; null when complete. */
  missing(cfg: Record<string, unknown>, secret: SecretResolver): string | null
}
