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

/** How long a successful fetch stays cached. Mirrors main's `SUCCESS_TTL_MS`: the catalog is
 *  account-dependent, so a renderer that lives for days must not keep one forever. Eviction is
 *  silent — the next composer to mount refetches. */
const SUCCESS_TTL_MS = 60 * 60 * 1000

/** Hooks to re-run after the cache changes out from under them (a refresh, or main reporting
 *  that the account changed). */
const listeners = new Set<() => void>()
function notifyAll(): void {
  for (const l of listeners) l()
}

export function clearCatalogStore(): void {
  cache.clear()
  inflight.clear()
}

function evictLater(instanceId: string, entry: ModelOptionInfo[], ms: number): void {
  const timer = setTimeout(() => {
    // Only evict if this is still the live entry — a refresh or clear may have replaced it.
    if (cache.get(instanceId) === entry) cache.delete(instanceId)
  }, ms)
  // `unref` exists on Node's timers (the vitest/jsdom runtime), not on the browser's number.
  ;(timer as { unref?: () => void }).unref?.()
}

/**
 * Drops this instance's cached catalog, asks main to re-read it from the CLI, and re-renders
 * every consumer — the Settings "Refresh models" action. Resolves once the new catalog (or the
 * failure marker) is in place.
 */
export async function refreshModelCatalog(instanceId: string): Promise<void> {
  cache.delete(instanceId)
  inflight.delete(instanceId)
  try {
    const models = ((await window.argus.models.refresh(instanceId)) ?? []) as ModelOptionInfo[]
    cache.set(instanceId, models)
    evictLater(instanceId, models, SUCCESS_TTL_MS)
  } catch {
    cache.set(instanceId, FAILED)
    evictLater(instanceId, FAILED, FAILURE_TTL_MS)
  }
  notifyAll()
}

/**
 * The model catalog for one provider instance, fetched once and shared.
 * Returns `[]` until it arrives and on any failure — a degraded options menu is
 * always preferable to a composer that cannot render.
 */
export function useModelCatalog(instanceId: string | null | undefined): ModelOptionInfo[] {
  const [version, bump] = useState(0)
  // Re-run the fetch effect below when the cache is invalidated: by `refreshModelCatalog`, or by
  // main reporting a changed account (it has already dropped its own copy).
  useEffect(() => {
    // Nothing to keep fresh without an instance — and no reason to touch the bridge for one.
    if (!instanceId) return
    const rerun = (): void => bump((n) => n + 1)
    listeners.add(rerun)
    const off = window.argus.models.onChanged(() => {
      clearCatalogStore()
      notifyAll()
    })
    return () => {
      listeners.delete(rerun)
      off()
    }
  }, [instanceId])
  useEffect(() => {
    if (!instanceId || cache.has(instanceId)) return
    if (!inflight.has(instanceId)) {
      inflight.set(
        instanceId,
        window.argus.models
          .catalog(instanceId)
          .then((m) => {
            const models = (m ?? []) as ModelOptionInfo[]
            cache.set(instanceId, models)
            evictLater(instanceId, models, SUCCESS_TTL_MS)
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
  }, [instanceId, version])
  return (instanceId && cache.get(instanceId)) || []
}
