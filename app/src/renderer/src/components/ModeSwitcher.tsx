import { useEffect, useState } from 'react'
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

  useEffect(() => {
    let live = true
    window.argus.modes
      .available(slug)
      .then((m) => {
        if (live) setModes(m)
      })
      .catch(() => {
        if (live) onError('Could not load available modes for this case.')
      })
    return () => {
      live = false
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps -- onError is a stable callback prop, not a reactive dep
  }, [slug])

  async function pick(mode: ModeId): Promise<void> {
    if (mode === activeMode) return
    try {
      const result = await window.argus.cases.setMode(slug, mode)
      onModeChanged(mode, result.sessionId)
    } catch {
      onError('Could not switch mode for this chat.')
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
          onClick={() => void pick(id)}
          className={`px-2.5 py-1 text-xs transition-colors ${
            id === activeMode ? 'bg-signal/10 text-ink' : 'text-dim hover:text-ink'
          } ${i !== modes.length - 1 ? 'border-r border-hair' : ''}`}
        >
          {MODES[id].label}
        </button>
      ))}
    </div>
  )
}
