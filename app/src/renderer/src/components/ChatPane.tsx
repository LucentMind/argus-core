import { useEffect, useRef, useState, useSyncExternalStore } from 'react'
import { agentStore } from '../lib/agentStore'
import { uiStore } from '../lib/uiStore'
import { MessageView } from './MessageView'
import { ToolCallCard } from './ToolCallCard'
import { Composer } from './Composer'
import { ApprovalCard } from './ApprovalCard'
import { SessionSwitcher } from './SessionSwitcher'

export function ChatPane({
  slug,
  sessionId,
  onSwitchSession,
  onCite,
  onJumpToTurn,
  focusTurnId = null,
  onFocusConsumed,
  prefill
}: {
  slug: string
  sessionId: number
  onSwitchSession: (id: number) => void
  onCite: (relPath: string, line: number) => void
  onJumpToTurn?: (sessionId: number, turnId: number | null) => void
  focusTurnId?: number | null
  onFocusConsumed?: () => void
  prefill?: string
}): React.JSX.Element {
  const state = useSyncExternalStore(
    (cb) => agentStore.subscribe(cb),
    () => agentStore.get(slug, sessionId)
  )
  const showToolCalls = useSyncExternalStore(
    (cb) => uiStore.subscribe(cb),
    () => uiStore.get().showToolCalls
  )
  const bottom = useRef<HTMLDivElement>(null)
  useEffect(() => {
    bottom.current?.scrollIntoView?.({ behavior: 'smooth' })
  }, [state.items.length, state.pending.length])

  const [flashTurnId, setFlashTurnId] = useState<number | null>(null)

  // jump-to-turn: the target turn's anchor may not exist yet (the target
  // session's history may still be hydrating), so wait until it shows up in
  // the transcript. Whether to flash is a pure derivation of focusTurnId +
  // state.items — adjust-state-during-render, keyed on focusTurnId like the
  // reset patterns above (reset to idle whenever the prop returns to null, so
  // a later jump to the same turn re-flashes). The actual DOM scroll + telling
  // the parent the jump was consumed are external-system effects.
  const targetExists =
    focusTurnId != null &&
    state.items.some((item) => item.kind === 'user' && item.turnId === focusTurnId)
  const [consumedFocusTurnId, setConsumedFocusTurnId] = useState<number | null>(null)
  if (focusTurnId == null) {
    if (consumedFocusTurnId !== null) setConsumedFocusTurnId(null)
  } else if (targetExists && focusTurnId !== consumedFocusTurnId) {
    setConsumedFocusTurnId(focusTurnId)
    setFlashTurnId(focusTurnId)
  }

  useEffect(() => {
    if (!targetExists) return
    document.querySelector(`[data-turn-id="${focusTurnId}"]`)?.scrollIntoView({ block: 'center' })
    onFocusConsumed?.()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [focusTurnId, targetExists])

  // the flash fade-out timer is independent of the focus-consumption effect
  // above so that clearing focusTurnId (via onFocusConsumed) doesn't cancel it
  useEffect(() => {
    if (flashTurnId == null) return
    const t = setTimeout(() => setFlashTurnId(null), 1200)
    return () => clearTimeout(t)
  }, [flashTurnId])

  // A default routing so ChatPane still works when no onJumpToTurn is wired
  // (e.g. existing tests); CaseWorkspace overrides this with the real
  // switch-then-focus handler.
  function handleJumpToTurn(targetSessionId: number, turnId: number | null): void {
    if (onJumpToTurn) {
      onJumpToTurn(targetSessionId, turnId)
      return
    }
    if (targetSessionId !== sessionId) onSwitchSession(targetSessionId)
  }

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <div className="flex h-9 items-center border-b border-hair px-3">
        <SessionSwitcher
          slug={slug}
          sessionId={sessionId}
          onSwitch={onSwitchSession}
          onJumpToTurn={handleJumpToTurn}
        />
      </div>
      <div className="flex-1 space-y-3 overflow-y-auto p-4">
        {state.items.map((item, i) => {
          if (item.kind === 'user') {
            const isFlashing = item.turnId != null && item.turnId === flashTurnId
            return (
              <div
                key={i}
                data-turn-id={item.turnId ?? undefined}
                className={`ml-12 rounded-r3 border border-hair p-3 text-sm text-ink transition-colors ${
                  isFlashing ? 'bg-signal/20' : 'bg-hi'
                }`}
              >
                {item.text}
              </div>
            )
          }
          if (item.kind === 'assistant') {
            return (
              <div key={i} className="mr-6">
                <MessageView markdown={item.text} onCite={onCite} />
                {item.streaming && <span className="text-xs text-mute">…</span>}
              </div>
            )
          }
          if (!showToolCalls) return null
          return <ToolCallCard key={item.toolCallId} item={item} />
        })}
        {state.pending.map((p) => (
          <ApprovalCard key={p.requestId} slug={slug} sessionId={sessionId} request={p} />
        ))}
        {state.sessionNote && <div className="text-xs text-danger">{state.sessionNote}</div>}
        <div ref={bottom} />
      </div>
      {state.running && (
        <div className="px-4 pb-1">
          <button
            className="font-mono text-xs text-mute transition-colors hover:text-danger"
            onClick={() => void window.argus.agent.interrupt(slug, sessionId)}
          >
            ■ stop
          </button>
        </div>
      )}
      {/* key: the draft (typed or Analyze-prefilled) belongs to one session — reset it on switch */}
      <Composer
        key={`${slug}#${sessionId}`}
        disabled={false}
        prefill={prefill}
        onSend={(t) => void window.argus.agent.send(slug, sessionId, t)}
      />
    </div>
  )
}
