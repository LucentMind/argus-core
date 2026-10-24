import type { ObservationIntent } from './intent'
import type { ObservationSink } from './sink'

/** Forwards every intent to every enabled adapter. One child failing never starves another;
 *  each child's last error is latched for its own health row (spec §4.2 / §5). */
export class FanOutSink implements ObservationSink {
  private errors: (string | null)[]
  private stopped = false
  constructor(private children: ObservationSink[]) {
    this.errors = children.map(() => null)
  }

  emit(intents: ObservationIntent[]): void {
    if (this.stopped) return
    this.children.forEach((c, i) => {
      try {
        c.emit(intents)
      } catch (err) {
        this.errors[i] = err instanceof Error ? err.message : String(err)
      }
    })
  }

  async flush(): Promise<void> {
    await this.settleAll((c) => c.flush())
  }

  async shutdown(): Promise<void> {
    if (this.stopped) return
    this.stopped = true
    await this.settleAll((c) => c.shutdown())
  }

  /** Runs `op` on every child; a sync throw or a rejection is latched, never propagated. */
  private async settleAll(op: (c: ObservationSink) => Promise<void>): Promise<void> {
    const results = await Promise.allSettled(
      this.children.map((c) => Promise.resolve().then(() => op(c)))
    )
    results.forEach((r, i) => {
      if (r.status === 'rejected') {
        this.errors[i] = r.reason instanceof Error ? r.reason.message : String(r.reason)
      }
    })
  }

  childErrors(): (string | null)[] {
    return this.children.map((c, i) => this.errors[i] ?? c.lastError?.() ?? null)
  }

  lastError(): string | null {
    return this.childErrors().find((e) => e !== null) ?? null
  }
}
