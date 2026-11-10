import type { ObservabilityProviderId } from '../../../../shared/observabilityProviders'
import type { ObservabilityProvider } from './types'
import { langfuseProvider } from './langfuse'
import { otlpProvider } from './otlp'

export type { ObservabilityProvider, SecretResolver } from './types'

/** The registry. `Record<ObservabilityProviderId, …>` makes a new id a compile error until its
 *  adapter is registered here. */
export const OBSERVABILITY_PROVIDERS: Record<ObservabilityProviderId, ObservabilityProvider> = {
  langfuse: langfuseProvider,
  otlp: otlpProvider
}
