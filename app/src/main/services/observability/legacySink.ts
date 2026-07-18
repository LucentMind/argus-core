import type { ObservationSink } from './sink'
import type { ObservationIntent } from './intent'
import type { LangfuseClientLike } from './langfuseClient'

/**
 * TEMPORARY: routes intents to the v3 REST client so the reducer can land
 * before the SDK swap. Deleted once `langfuseSink.ts` is in place.
 */
export class LegacySink implements ObservationSink {
  private traceIds = new Map<string, string>()

  constructor(private client: LangfuseClientLike) {}

  private traceId(seed: string): string {
    let id = this.traceIds.get(seed)
    if (!id) {
      id = seed
      this.traceIds.set(seed, id)
    }
    return id
  }

  emit(intents: ObservationIntent[]): void {
    for (const i of intents) {
      const traceId = this.traceId(i.seed)
      switch (i.kind) {
        case 'trace-root':
          this.client.trace({ id: traceId, name: i.name, metadata: i.metadata })
          break
        case 'generation':
          this.client.generation({
            traceId,
            name: i.name,
            model: i.model,
            usage: { input: i.usage?.input, output: i.usage?.output },
            ...(i.costUsd != null ? { totalCost: i.costUsd } : {}),
            ...(i.input != null ? { input: i.input } : {}),
            ...(i.output != null ? { output: i.output } : {})
          })
          break
        case 'tool':
          this.client.span({
            traceId,
            name: `tool:${i.name}`,
            level: i.isError ? 'ERROR' : 'DEFAULT',
            ...(i.output != null ? { output: i.output } : {})
          })
          break
        case 'event':
          this.client.span({
            traceId,
            name: i.name,
            level: i.level ?? 'DEFAULT',
            ...(i.metadata ? { metadata: i.metadata } : {})
          })
          break
        case 'score':
          this.client.score({ traceId, name: i.name, value: i.value, comment: i.comment })
          break
      }
    }
  }

  flush(): Promise<void> {
    return this.client.flushAsync()
  }

  shutdown(): Promise<void> {
    return this.client.shutdownAsync()
  }
}
