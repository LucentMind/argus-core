import { useCallback, useEffect, useState } from 'react'
import type { HivemindItem, PushReceipt } from '../../../../shared/hivemind'
import type { SourceControlStatus } from '../../../../shared/sourcecontrol'

/**
 * Shared readiness + receipt state for the in-place Share buttons (Tier 2), plus the
 * hive item index the Library needs for Claim and the update marker. The payload was
 * always fetched here; only `repo` and `pushes` used to survive the callback.
 * The Promise.resolve wrappers turn a missing preload namespace (tests that
 * don't mock hivemind/sourceControl) into "share disabled", not a crash.
 */
export function useSharePush(): {
  shareReady: boolean
  shareTip: string
  pushes: Record<string, PushReceipt>
  /** Hive items keyed `skill/<name>` | `reference/<name>`, like {@link pushes}. */
  hiveItems: Map<string, HivemindItem>
  refresh: () => void
} {
  const [gh, setGh] = useState<SourceControlStatus | null>(null)
  const [repoSet, setRepoSet] = useState(false)
  const [pushes, setPushes] = useState<Record<string, PushReceipt>>({})
  const [hiveItems, setHiveItems] = useState<Map<string, HivemindItem>>(new Map())

  const refresh = useCallback(() => {
    void Promise.resolve()
      .then(() => window.argus.hivemind.get())
      .then((p) => {
        setRepoSet(p.repo.trim() !== '')
        setPushes(p.pushes)
        setHiveItems(new Map(p.items.map((it) => [`${it.kind}/${it.name}`, it])))
      })
      .catch(() => undefined)
    void Promise.resolve()
      .then(() => window.argus.sourceControl.status())
      .then(setGh)
      .catch(() => undefined)
  }, [])

  useEffect(() => refresh(), [refresh])

  const shareReady = repoSet && gh !== null && gh.installed && gh.authenticated
  return {
    shareReady,
    shareTip: shareReady
      ? 'Share to HiveMind…'
      : 'Sharing needs a configured HiveMind repo and an authenticated GitHub CLI — see Settings → Team.',
    pushes,
    hiveItems,
    refresh
  }
}
