import { useCallback, useEffect, useState } from 'react'
import type { PushReceipt } from '../../../../shared/hivemind'
import type { SourceControlStatus } from '../../../../shared/sourcecontrol'

/**
 * Shared readiness + receipt state for the in-place Share buttons (Tier 2).
 * The Promise.resolve wrappers turn a missing preload namespace (tests that
 * don't mock hivemind/sourceControl) into "share disabled", not a crash.
 */
export function useSharePush(): {
  shareReady: boolean
  shareTip: string
  pushes: Record<string, PushReceipt>
  refresh: () => void
} {
  const [gh, setGh] = useState<SourceControlStatus | null>(null)
  const [repoSet, setRepoSet] = useState(false)
  const [pushes, setPushes] = useState<Record<string, PushReceipt>>({})

  const refresh = useCallback(() => {
    void Promise.resolve()
      .then(() => window.argus.hivemind.get())
      .then((p) => {
        setRepoSet(p.repo.trim() !== '')
        setPushes(p.pushes)
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
      : 'Sharing needs a configured HiveMind repo and an authenticated GitHub CLI — see Settings → HiveMind.',
    pushes,
    refresh
  }
}
