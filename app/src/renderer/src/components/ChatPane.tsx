import { useEffect, useLayoutEffect, useRef, useState, useSyncExternalStore } from 'react'
import type { ChatJumpTarget, SessionSummary } from '../../../shared/types'
import type { RunOptionSelection } from '../../../shared/runOptions'
import type { PermissionMode } from '../../../shared/settings'
import { agentStore, type TranscriptItem } from '../lib/agentStore'
import { citationsTray } from '../lib/citationsTray'
import { composerDraft } from '../lib/composerDraft'
import { composerAttachments } from '../lib/composerAttachments'
import { attachFiles } from '../lib/attachFiles'
import { reposStore } from '../lib/reposStore'
import type { CiteTarget } from '../lib/citations'
import { CitedText } from './CitedText'
import { uiStore } from '../lib/uiStore'
import { MessageView } from './MessageView'
import { ToolCallCard } from './ToolCallCard'
import { Composer } from './Composer'
import { ApprovalCard } from './ApprovalCard'
import { QuestionCard } from './QuestionCard'
import { ChatFind } from './ChatFind'

// The FTS snippet is a contiguous region of the indexed text with matched
// terms wrapped in «» and boundary ellipses — stripping those yields a raw
// substring of the original message, usable to find the message in-turn.
/** px of slack below which the transcript still counts as scrolled to the end */
const BOTTOM_SLACK = 24

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
  session = null,
  onModelChange,
  onRunOptionsChange,
  onPermissionModeChange,
  onCite,
  focusTarget = null,
  onFocusConsumed,
  prefill,
  findOpen = false,
  onFindOpenChange = () => {}
}: {
  slug: string
  sessionId: number
  /** Summary of the chat being shown — carries its pinned provider instance + model. */
  session?: SessionSummary | null
  onModelChange?: (instanceId: string, model: string) => void
  /** Replace this chat's option selections. */
  onRunOptionsChange?: (sel: RunOptionSelection[]) => void
  /** Pin this chat's permission mode. */
  onPermissionModeChange?: (mode: PermissionMode) => void
  onCite: (cite: CiteTarget) => void
  focusTarget?: ChatJumpTarget | null
  onFocusConsumed?: () => void
  prefill?: string
  /** In-transcript find overlay's open state — owned by CaseWorkspace so both the Ctrl+F
   *  keystroke here and the bar's find button (PanelTabStrip) drive the same state. */
  findOpen?: boolean
  onFindOpenChange?: (open: boolean) => void
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
  const attachments = useSyncExternalStore(
    (cb) => composerAttachments.subscribe(cb),
    () => composerAttachments.get(slug, sessionId)
  )
  // Evidence deleted from the Files card while its chip is still staged here
  // must drop the chip too — otherwise a stale chip still carries its relPath
  // and sending it emits `[evidence/<deleted-file>]`, which the agent's Read
  // then fails on. `evidence:changed` also fires on ordinary ingest, so
  // pruning is driven purely by "this relPath is no longer in the case's
  // evidence list" rather than by what kind of change occurred — that keeps a
  // normal paste (or an unrelated case's ingest) from ever touching a chip
  // here. Only 'ready' attachments carry a relPath; 'pending' (ingest still
  // in flight) and 'error' ones are left alone.
  useEffect(() => {
    const off = window.argus.evidence.onChanged?.((changedSlug) => {
      if (changedSlug !== slug) return
      window.argus.evidence.list(slug).then(
        (records: { relPath: string }[]) => {
          const relPaths = new Set(records.map((r) => r.relPath))
          for (const a of composerAttachments.get(slug, sessionId)) {
            if (a.status === 'ready' && a.relPath && !relPaths.has(a.relPath)) {
              composerAttachments.remove(slug, sessionId, a.id)
            }
          }
        },
        (err) => console.warn(`[evidence] list failed for ${slug}: ${(err as Error).message}`)
      )
    })
    return () => off?.()
  }, [slug, sessionId])
  const bottom = useRef<HTMLDivElement>(null)
  const paneRef = useRef<HTMLDivElement>(null)
  // Opening a case/chat hydrates the transcript asynchronously, so the pane
  // first paints empty at scrollTop 0 and only then receives its items.
  // Animating that first jump made every open visibly scroll from the top
  // through the whole transcript, so the first anchor for a session is instant
  // and only content arriving while the chat is already open animates. Keyed on
  // the session rather than on item counts because the scroll container is not
  // remounted per session: switching between two chats of equal length would
  // otherwise skip the effect entirely and inherit the previous scrollTop.
  //
  // It is a layout effect, not a passive one: switching to an already-hydrated
  // chat commits the whole new transcript at once, and a passive effect would
  // run only after the browser had painted that transcript at the outgoing
  // chat's scrollTop — one visible frame at the wrong position followed by a
  // jump. Anchoring before paint puts the scroll in the same frame as the
  // content.
  const anchoredKey = useRef<string | null>(null)
  const scrollRef = useRef<HTMLDivElement>(null)
  const contentRef = useRef<HTMLDivElement>(null)
  const pinnedToBottom = useRef(true)
  const sessionKey = `${slug}:${sessionId}`
  const rendered = state.items.length + state.pending.length + state.pendingDialogs.length
  useLayoutEffect(() => {
    const initial = anchoredKey.current !== sessionKey
    // nothing to anchor to yet — wait for hydration so the first jump is the
    // one that lands at the bottom
    if (initial && rendered === 0) return
    anchoredKey.current = sessionKey
    if (initial) pinnedToBottom.current = true
    bottom.current?.scrollIntoView?.({ behavior: initial ? 'auto' : 'smooth' })
  }, [sessionKey, rendered])

  // Anchoring once is not enough: the transcript keeps growing after the
  // anchor runs. A ```mermaid fence mounts as its raw source and swaps in a
  // taller SVG 150ms later (MermaidBlock), images decode late, and markdown
  // reflows — each of which pushes the bottom below the anchored position, so
  // a chat that was anchored correctly still ends up scrolled short of the
  // end. Re-pin on every content resize, but only while the user is actually
  // at the bottom, so scrolling up to read is never yanked back down.
  function handleScroll(): void {
    const el = scrollRef.current
    if (!el) return
    pinnedToBottom.current = el.scrollHeight - el.scrollTop - el.clientHeight <= BOTTOM_SLACK
  }

  useEffect(() => {
    const el = scrollRef.current
    const content = contentRef.current
    if (!el || !content || typeof ResizeObserver === 'undefined') return
    const ro = new ResizeObserver(() => {
      if (pinnedToBottom.current) el.scrollTop = el.scrollHeight
    })
    ro.observe(content)
    return () => ro.disconnect()
  }, [])

  // in-chat find (Ctrl/Cmd+F): the overlay is a pure component (ChatFind)
  // that owns the query text; ChatPane owns opening/closing (via the
  // findOpen/onFindOpenChange props, lifted to CaseWorkspace so the bar's
  // find button can drive the same state), the scroll to the current match,
  // and the ring classes on matching items.
  const [findMatches, setFindMatches] = useState<number[]>([])
  const [currentFindIndex, setCurrentFindIndex] = useState<number | null>(null)

  useEffect(() => {
    function onKeyDown(e: KeyboardEvent): void {
      if ((e.ctrlKey || e.metaKey) && e.key === 'f') {
        e.preventDefault()
        onFindOpenChange(true)
      }
    }
    window.addEventListener('keydown', onKeyDown)
    return () => window.removeEventListener('keydown', onKeyDown)
  }, [onFindOpenChange])

  function closeFind(): void {
    onFindOpenChange(false)
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

  function findRingClass(i: number): string {
    if (i === currentFindIndex) return 'ring-2 ring-signal'
    if (findMatches.includes(i)) return 'ring-1 ring-signal/40'
    return ''
  }

  return (
    <div ref={paneRef} className="relative flex min-h-0 flex-1 flex-col">
      {findOpen && (
        <ChatFind
          items={state.items}
          onNavigate={navigateFind}
          onClose={closeFind}
          onMatchesChange={setFindMatches}
        />
      )}
      <div ref={scrollRef} onScroll={handleScroll} className="flex-1 overflow-y-auto p-4">
        {/* inner content node: the scroll container's own box is fixed by the
            flex layout, so only this wrapper's height reports the transcript
            growing (mermaid SVGs, images) to the ResizeObserver above */}
        <div ref={contentRef} className="space-y-3">
          {state.items.map((item, i) => {
            if (item.kind === 'user') {
              return (
                <div
                  key={i}
                  data-turn-id={item.turnId ?? undefined}
                  data-item-index={i}
                  className={`ml-12 min-w-0 ${item.composed ? '' : 'whitespace-pre-wrap'} break-words rounded-r3 border border-hair p-3 text-sm text-ink transition-colors ${
                    i === flashIndex ? 'bg-signal/20' : 'bg-hi'
                  } ${findRingClass(i)}`}
                >
                  {item.composed ? (
                    <MessageView
                      markdown={item.text}
                      onCite={onCite}
                      caseSlug={slug}
                      repoNames={repoNames}
                    />
                  ) : (
                    <CitedText
                      text={item.text}
                      onCite={onCite}
                      caseSlug={slug}
                      repoNames={repoNames}
                    />
                  )}
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
                    streaming={item.streaming}
                  />
                  {item.streaming && <span className="text-xs text-mute">…</span>}
                </div>
              )
            }
            if (!showToolCalls) return null
            return <ToolCallCard key={item.toolCallId} item={item} />
          })}
          {state.pending.map((p) => (
            <ApprovalCard
              key={p.requestId}
              slug={slug}
              sessionId={sessionId}
              instanceId={session?.instanceId ?? null}
              request={p}
            />
          ))}
          {state.pendingDialogs.map((d) => (
            <QuestionCard key={d.dialogId} slug={slug} sessionId={sessionId} dialog={d} />
          ))}
          {state.sessionNote && <div className="text-xs text-danger">{state.sessionNote}</div>}
          <div ref={bottom} />
        </div>
      </div>
      {/* key: the draft (typed or Analyze-prefilled) belongs to one session — reset it on switch */}
      <Composer
        key={`${slug}#${sessionId}`}
        disabled={false}
        prefill={stagedDraft ?? prefill}
        onSend={(t) => {
          void window.argus.agent.send(slug, sessionId, t)
          composerDraft.clear(slug, sessionId)
          composerAttachments.clear(slug, sessionId)
        }}
        session={session}
        onModelChange={onModelChange}
        onRunOptionsChange={onRunOptionsChange}
        onPermissionModeChange={onPermissionModeChange}
        running={state.running}
        onStop={() => void window.argus.agent.interrupt(slug, sessionId)}
        citations={citations}
        onRemoveCitation={(i) => citationsTray.remove(slug, sessionId, i)}
        onCitationsConsumed={() => citationsTray.clear(slug, sessionId)}
        attachments={attachments}
        onRemoveAttachment={(id) => composerAttachments.remove(slug, sessionId, id)}
        onAttachFiles={(files, opts) => void attachFiles(slug, sessionId, files, opts)}
      />
    </div>
  )
}
