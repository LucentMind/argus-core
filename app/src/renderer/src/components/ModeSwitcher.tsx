import { useCallback, useEffect, useState } from 'react'
import { DEFAULT_MODE, MODES, type ModeId } from '../../../shared/modes'

export function ModeSwitcher({
  slug,
  activeMode,
  onModeChanged,
  onError
}: {
  slug: string
  activeMode: ModeId
  /** The parent switches the active chat to `sessionId` — the mode's existing chat, or a
   *  freshly created one (`cases:set-mode`'s contract). */
  onModeChanged: (mode: ModeId, sessionId: number) => void
  /** Surfaces a load or switch failure to the caller (CaseWorkspace shows it as the
   *  chat-header error line). Keeps this component from failing silently — see the
   *  unhandled rejection this replaced. */
  onError: (message: string) => void
}): React.JSX.Element {
  const [modes, setModes] = useState<ModeId[]>([DEFAULT_MODE])
  const [pending, setPending] = useState<ModeId | null>(null)

  const refresh = useCallback((): void => {
    window.argus.modes
      .available(slug)
      .then(setModes)
      .catch(() => onError('Could not load available modes for this case.'))
    // eslint-disable-next-line react-hooks/exhaustive-deps -- onError is a stable callback prop, not a reactive dep
  }, [slug])

  useEffect(refresh, [refresh])

  // Availability is user-mutable — review unlocks on a linked repo — so a list fetched once
  // at mount goes stale in both directions: it offers a Review button the main process then
  // rejects, and hides one that a fresh link just made legitimate. The same broadcast the
  // repo chips already listen to is the invalidation signal.
  useEffect(() => {
    if (!window.argus.workspaces?.onChanged) return
    return window.argus.workspaces.onChanged((changed) => {
      if (changed === slug) refresh()
    })
  }, [slug, refresh])

  async function pick(mode: ModeId): Promise<void> {
    if (mode === activeMode || pending) return
    // Entering review fetches PR worktrees and then searches GitHub, so this is slow by
    // nature. aria-pressed deliberately does NOT flip here (the parent owns the mode after
    // it persists — see the no-optimistic-mirror contract); busy is the honest signal.
    setPending(mode)
    try {
      const result = await window.argus.cases.setMode(slug, mode)
      onModeChanged(mode, result.sessionId)
    } catch {
      onError('Could not switch mode for this chat.')
      // a rejected switch usually means availability moved under us (a repo was unlinked
      // elsewhere), so resync rather than leaving the same dead button clickable
      refresh()
    } finally {
      setPending(null)
    }
  }

  // Invisible-until-useful: a lone investigation mode shows a static label, no controls —
  // same gate as a driver-capability chip that hides itself until there's a real choice.
  if (modes.length <= 1) {
    return <span className="text-xs text-mute">{MODES[activeMode].label}</span>
  }

  return (
    <div
      role="group"
      aria-label="Case mode"
      className="flex shrink-0 overflow-hidden rounded-r2 border border-hair"
    >
      {modes.map((id, i) => (
        <button
          key={id}
          type="button"
          aria-label={`Case mode · ${MODES[id].label}`}
          aria-pressed={id === activeMode}
          aria-busy={pending === id}
          disabled={pending !== null}
          onClick={() => void pick(id)}
          className={`px-2.5 py-1 text-xs transition-colors ${
            id === activeMode ? 'bg-signal/10 text-ink' : 'text-dim hover:text-ink'
          } ${pending === id ? 'animate-pulse bg-hair text-ink' : ''} ${
            pending !== null && pending !== id ? 'opacity-50' : ''
          } ${i !== modes.length - 1 ? 'border-r border-hair' : ''}`}
        >
          {MODES[id].label}
        </button>
      ))}
    </div>
  )
}
