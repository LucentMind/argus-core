import { useEffect, useRef, useState, useSyncExternalStore } from 'react'
import type { ChatJumpTarget } from '../../../shared/types'
import { agentStore, type TranscriptItem } from '../lib/agentStore'
import { citationsTray } from '../lib/citationsTray'
import { composerDraft } from '../lib/composerDraft'
import { reposStore } from '../lib/reposStore'
import type { CiteTarget } from '../lib/citations'
import { CitedText } from './CitedText'
import { uiStore } from '../lib/uiStore'
import { MessageView } from './MessageView'
import { ToolCallCard } from './ToolCallCard'
import { Composer } from './Composer'
import { ApprovalCard } from './ApprovalCard'
import { SessionSwitcher } from './SessionSwitcher'
import { ChatFind } from './ChatFind'

// The FTS snippet is a contiguous region of the indexed text with matched
// terms wrapped in «» and boundary ellipses — stripping those yields a raw
// substring of the original message, usable to find the message in-turn.
function snippetNeedle(snippet?: string): string | null {
  if (!snippet) return null
  const s = snippet.replace(/[«»]/g, '').replace(/^…/, '').replace(/…$/, '').trim()
  return s || null
}

/**
 * Resolve a chat-search jump to the transcript item to scroll to and flash.
 * A hit identifies a turn, a role, and a snippet — not a message id — so the
 * exact message is found in-turn: prefer the item of the hit's role whose
 * text contains the snippet, then any item of that role, then the turn's
 * user message. Returns -1 while the target session is still hydrating.
 */
function resolveFocusIndex(items: TranscriptItem[], target: ChatJumpTarget | null): number {
  if (target == null || target.turnId == null) return -1
  const inTurnWithRole = (
    item: TranscriptItem
  ): item is Extract<TranscriptItem, { kind: 'user' | 'assistant' }> =>
    (item.kind === 'user' || item.kind === 'assistant') &&
    item.turnId === target.turnId &&
    (!target.role || item.kind === target.role)
  const needle = snippetNeedle(target.snippet)
  if (needle) {
    const i = items.findIndex((item) => inTurnWithRole(item) && item.text.includes(needle))
    if (i >= 0) return i
  }
  const i = items.findIndex(inTurnWithRole)
  if (i >= 0) return i
  return items.findIndex((item) => item.kind === 'user' && item.turnId === target.turnId)
}

export function ChatPane({
  slug,
  sessionId,
  onSwitchSession,
  onCite,
  onJumpToTurn,
  focusTarget = null,
  onFocusConsumed,
  prefill
}: {
  slug: string
  sessionId: number
  onSwitchSession: (id: number) => void
  onCite: (cite: CiteTarget) => void
  onJumpToTurn?: (sessionId: number, target: ChatJumpTarget) => void
  focusTarget?: ChatJumpTarget | null
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
  const citations = useSyncExternalStore(
    (cb) => citationsTray.subscribe(cb),
    () => citationsTray.get(slug, sessionId)
  )
  const repoNames = useSyncExternalStore(
    (cb) => reposStore.subscribe(cb),
    () => reposStore.get(slug)
  ).names
  // text a panel staged via sendToAgent for this session, fed to the Composer as
  // prefill so the user reviews/edits before sending
  const stagedDraft = useSyncExternalStore(
    (cb) => composerDraft.subscribe(cb),
    () => composerDraft.get(slug, sessionId)
  )
  const bottom = useRef<HTMLDivElement>(null)
  const paneRef = useRef<HTMLDivElement>(null)
  useEffect(() => {
    bottom.current?.scrollIntoView?.({ behavior: 'smooth' })
  }, [state.items.length, state.pending.length])

  // in-chat find (Ctrl/Cmd+F): the overlay is a pure component (ChatFind)
  // that owns the query text; ChatPane owns opening/closing, the scroll to
  // the current match, and the ring classes on matching items.
  const [findOpen, setFindOpen] = useState(false)
  const [findMatches, setFindMatches] = useState<number[]>([])
  const [currentFindIndex, setCurrentFindIndex] = useState<number | null>(null)

  useEffect(() => {
    function onKeyDown(e: KeyboardEvent): void {
      if ((e.ctrlKey || e.metaKey) && e.key === 'f') {
        e.preventDefault()
        setFindOpen(true)
      }
    }
    window.addEventListener('keydown', onKeyDown)
    return () => window.removeEventListener('keydown', onKeyDown)
  }, [])

  function closeFind(): void {
    setFindOpen(false)
    setFindMatches([])
    setCurrentFindIndex(null)
    paneRef.current?.querySelector<HTMLTextAreaElement>('textarea')?.focus()
  }

  function navigateFind(itemIndex: number): void {
    setCurrentFindIndex(itemIndex)
    paneRef.current
      ?.querySelector(`[data-item-index="${itemIndex}"]`)
      ?.scrollIntoView?.({ block: 'center' })
  }

  const [flashIndex, setFlashIndex] = useState<number | null>(null)

  // jump-to-message: the target item may not exist yet (the target session's
  // history may still be hydrating), so wait until it resolves in the
  // transcript. Whether to flash is a pure derivation of focusTarget +
  // state.items — adjust-state-during-render, keyed on the focusTarget
  // reference like the reset patterns above (reset to idle whenever the prop
  // returns to null, so a later jump to the same message re-flashes). The
  // actual DOM scroll + telling the parent the jump was consumed are
  // external-system effects.
  const focusIndex = resolveFocusIndex(state.items, focusTarget)
  const [consumedTarget, setConsumedTarget] = useState<ChatJumpTarget | null>(null)
  if (focusTarget == null) {
    if (consumedTarget !== null) setConsumedTarget(null)
  } else if (focusIndex >= 0 && focusTarget !== consumedTarget) {
    setConsumedTarget(focusTarget)
    setFlashIndex(focusIndex)
  }

  useEffect(() => {
    if (focusTarget == null || focusIndex < 0) return
    paneRef.current
      ?.querySelector(`[data-item-index="${focusIndex}"]`)
      ?.scrollIntoView?.({ block: 'center' })
    onFocusConsumed?.()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [focusTarget, focusIndex])

  // the flash fade-out timer is independent of the focus-consumption effect
  // above so that clearing focusTarget (via onFocusConsumed) doesn't cancel it
  useEffect(() => {
    if (flashIndex == null) return
    const t = setTimeout(() => setFlashIndex(null), 1200)
    return () => clearTimeout(t)
  }, [flashIndex])

  // A default routing so ChatPane still works when no onJumpToTurn is wired
  // (e.g. existing tests); CaseWorkspace overrides this with the real
  // switch-then-focus handler.
  function handleJumpToTurn(targetSessionId: number, target: ChatJumpTarget): void {
    if (onJumpToTurn) {
      onJumpToTurn(targetSessionId, target)
      return
    }
    if (targetSessionId !== sessionId) onSwitchSession(targetSessionId)
  }

  function findRingClass(i: number): string {
    if (i === currentFindIndex) return 'ring-2 ring-signal'
    if (findMatches.includes(i)) return 'ring-1 ring-signal/40'
    return ''
  }

  return (
    <div ref={paneRef} className="relative flex min-h-0 flex-1 flex-col">
      <div className="flex h-9 items-center border-b border-hair px-3">
        <SessionSwitcher
          slug={slug}
          sessionId={sessionId}
          onSwitch={onSwitchSession}
          onJumpToTurn={handleJumpToTurn}
        />
      </div>
      {findOpen && (
        <ChatFind
          items={state.items}
          onNavigate={navigateFind}
          onClose={closeFind}
          onMatchesChange={setFindMatches}
        />
      )}
      <div className="flex-1 space-y-3 overflow-y-auto p-4">
        {state.items.map((item, i) => {
          if (item.kind === 'user') {
            return (
              <div
                key={i}
                data-turn-id={item.turnId ?? undefined}
                data-item-index={i}
                className={`ml-12 min-w-0 break-words rounded-r3 border border-hair p-3 text-sm text-ink transition-colors ${
                  i === flashIndex ? 'bg-signal/20' : 'bg-hi'
                } ${findRingClass(i)}`}
              >
                <CitedText text={item.text} onCite={onCite} caseSlug={slug} repoNames={repoNames} />
              </div>
            )
          }
          if (item.kind === 'assistant') {
            return (
              <div
                key={i}
                data-item-index={i}
                className={`mr-6 min-w-0 break-words rounded-r3 transition-colors ${
                  i === flashIndex ? 'bg-signal/20' : ''
                } ${findRingClass(i)}`}
              >
                <MessageView
                  markdown={item.text}
                  onCite={onCite}
                  caseSlug={slug}
                  repoNames={repoNames}
                />
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
        prefill={stagedDraft ?? prefill}
        onSend={(t) => {
          void window.argus.agent.send(slug, sessionId, t)
          composerDraft.clear(slug, sessionId)
        }}
        citations={citations}
        onRemoveCitation={(i) => citationsTray.remove(slug, sessionId, i)}
        onCitationsConsumed={() => citationsTray.clear(slug, sessionId)}
      />
    </div>
  )
}
