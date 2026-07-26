import { useCallback, useEffect, useState } from 'react'
import { confirm } from '../../lib/confirmStore'

/**
 * Guard 3 of the override safety story (spec, "Override safety").
 *
 * Rendered in Settings generally rather than on the Prompts page: someone who has FORGOTTEN
 * they set an override will not visit the page that sets them, and a stale override silently
 * changes every subsequent debugging session.
 */
export function OverrideBanner({ devTools }: { devTools: boolean }): React.JSX.Element | null {
  const [ids, setIds] = useState<string[]>([])
  // Separate from the banner itself: a failed clear must not hide the override list the
  // banner exists to show — the overrides are still active, and that is the more important fact.
  const [mutationError, setMutationError] = useState<string | null>(null)

  const refresh = useCallback(() => {
    // The channel is gated; calling it in a normal build would reject on every Settings mount.
    if (!devTools) return
    window.argus.devPrompts.overrides().then(setIds, () => setIds([]))
  }, [devTools])

  useEffect(() => {
    refresh()
    // A save on the Prompts page must light the banner without a Settings remount.
    return window.argus.devPrompts.onChanged(setIds)
  }, [refresh])

  if (!devTools || ids.length === 0) return null

  const clearAll = async (): Promise<void> => {
    const ok = await confirm({
      title: `Clear ${ids.length} prompt override${ids.length === 1 ? '' : 's'}?`,
      message:
        'Every prompt goes back to its built-in default on the next session. Any unsaved draft edit in an open Prompts editor is discarded too.',
      confirmLabel: 'Clear all',
      danger: true
    })
    if (!ok) return
    try {
      const payload = await window.argus.devPrompts.clearAll()
      setIds(payload.activeOverrideIds)
      setMutationError(null)
    } catch (e) {
      setMutationError((e as Error).message)
    }
  }

  return (
    <div className="flex flex-col gap-2">
      <div
        role="alert"
        className="flex items-center gap-3 rounded-r2 border border-defect/40 bg-defect/10 px-3 py-2 text-xs text-defect"
      >
        <span className="flex-1">
          {ids.length} prompt override{ids.length === 1 ? ' is' : 's are'} active — the agent is not
          running on built-in prompts.{' '}
          <span className="font-mono text-[10px]">{ids.join(', ')}</span>
        </span>
        <button
          className="underline transition-colors hover:text-ink"
          onClick={() => void clearAll()}
        >
          Clear all
        </button>
      </div>
      {mutationError && (
        <p
          role="alert"
          className="rounded-r2 border border-danger/40 bg-danger/10 p-2 text-xs text-danger"
        >
          {mutationError}
        </p>
      )}
    </div>
  )
}
