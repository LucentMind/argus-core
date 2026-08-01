import { useEffect, useState } from 'react'
import type { ModelOptionInfo } from '../../../shared/runOptions'

const cache = new Map<string, ModelOptionInfo[]>()
const inflight = new Map<string, Promise<void>>()

/** Identity sentinel for "this instance's fetch failed". Cached like any other entry so a
 *  burst of mounts shares one failure, but distinguishable from a genuinely empty catalog,
 *  which is what the eviction below keys off. Mirrors main's `STATIC_FALLBACK` identity check
 *  in drivers/claude/catalog.ts. */
const FAILED: ModelOptionInfo[] = []

/** How long a failed fetch stays cached. Same value and same reason as the main-process
 *  side: long enough that a cold-start burst shares one round trip, short enough that the
 *  composer recovers on its own — no reload, no restart — once the CLI comes back. Without
 *  it, one failure pinned an empty options menu for the whole renderer process lifetime,
 *  silently, while main had already healed. */
const FAILURE_TTL_MS = 60000

export function clearCatalogStore(): void {
  cache.clear()
  inflight.clear()
}

/**
 * The model catalog for one provider instance, fetched once and shared.
 * Returns `[]` until it arrives and on any failure — a degraded options menu is
 * always preferable to a composer that cannot render.
 */
export function useModelCatalog(instanceId: string | null | undefined): ModelOptionInfo[] {
  const [, bump] = useState(0)
  useEffect(() => {
    if (!instanceId || cache.has(instanceId)) return
    if (!inflight.has(instanceId)) {
      inflight.set(
        instanceId,
        window.argus.models
          .catalog(instanceId)
          .then((m) => {
            cache.set(instanceId, (m ?? []) as ModelOptionInfo[])
          })
          .catch(() => {
            cache.set(instanceId, FAILED)
            // Once per failed fetch, not per mount: this callback runs on the shared
            // in-flight promise. Without it a permanently degraded menu is invisible.
            console.warn(
              `[catalog] model catalog fetch failed for instance ${instanceId}; the composer's ` +
                'run options will be limited until it succeeds. Retrying in 60s.'
            )
            setTimeout(() => {
              // Only evict if this failure is still the live entry — a clearCatalogStore()
              // or a later successful fetch may have replaced it.
              if (cache.get(instanceId) === FAILED) cache.delete(instanceId)
            }, FAILURE_TTL_MS)
          })
          .finally(() => {
            inflight.delete(instanceId)
          })
      )
    }
    let alive = true
    void inflight.get(instanceId)?.then(() => {
      if (alive) bump((n) => n + 1)
    })
    return () => {
      alive = false
    }
  }, [instanceId])
  return (instanceId && cache.get(instanceId)) || []
}
