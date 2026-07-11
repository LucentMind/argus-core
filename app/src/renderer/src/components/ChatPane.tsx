import { useEffect, useRef, useSyncExternalStore } from 'react'
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
  prefill
}: {
  slug: string
  sessionId: number
  onSwitchSession: (id: number) => void
  onCite: (relPath: string, line: number) => void
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

  // Search-driven navigation (Task 9) will consume the turnId and scroll to
  // it; for now, jumping to a turn in another session just switches to it.
  // The prop type still carries turnId — a narrower handler is assignable.
  function handleJumpToTurn(targetSessionId: number): void {
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
            return (
              <div
                key={i}
                className="ml-12 rounded-r3 border border-hair bg-hi p-3 text-sm text-ink"
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
