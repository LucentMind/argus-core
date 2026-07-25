import { useEffect, useState } from 'react'
import { MODES, type ModeId } from '../../../shared/modes'

export function ModeSwitcher({
  slug,
  sessionId,
  activeMode,
  onModeChanged
}: {
  slug: string
  sessionId: number
  activeMode: ModeId
  onModeChanged: (mode: ModeId) => void
}): React.JSX.Element {
  const [modes, setModes] = useState<ModeId[]>(['investigation'])

  useEffect(() => {
    let live = true
    void window.argus.modes.available(slug).then((m) => {
      if (live) setModes(m)
    })
    return () => {
      live = false
    }
  }, [slug])

  async function pick(mode: ModeId): Promise<void> {
    if (mode === activeMode) return
    await window.argus.sessions.setMode(sessionId, mode)
    onModeChanged(mode)
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
