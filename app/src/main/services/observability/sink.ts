import type { ObservationIntent } from './intent'

/**
 * Backend for observation intents. `emit` must be synchronous and non-blocking:
 * it sits on the agent event hot path. Async work is the sink's own business,
 * and `flush` must settle it before returning.
 */
export interface ObservationSink {
  emit(intents: ObservationIntent[]): void
  flush(): Promise<void>
  shutdown(): Promise<void>
}
