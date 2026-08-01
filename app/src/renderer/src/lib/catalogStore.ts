import { useEffect, useState } from 'react'
import type { ModelOptionInfo } from '../../../shared/runOptions'

const cache = new Map<string, ModelOptionInfo[]>()
const inflight = new Map<string, Promise<void>>()

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
            cache.set(instanceId, [])
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
