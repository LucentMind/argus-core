import { useEffect, useRef, useState, useSyncExternalStore } from 'react'
import { PanelLeft, PanelRight } from 'lucide-react'
import { IconBtn, SectionLabel } from './ui'
import { SearchBar } from './SearchBar'
import { CaseFiles } from './CaseFiles'
import { ChatPane } from './ChatPane'
import { ReviewRunButton } from './ReviewRunButton'
import { FindingsPane } from './FindingsPane'
import { JiraSection } from './JiraSection'
import { ReposSection } from './ReposSection'
import { PrCompanionSection } from './PrCompanionSection'
import { PrPickerDialog } from './PrPickerDialog'
import type { PrBinding, PrSearchResult } from '../../../shared/pr'
import { SimilarCasesCard } from './SimilarCasesCard'
import { PanelTabStrip } from './PanelTabStrip'
import { PanelDock } from './PanelDock'
import { agentStore, wireAgentStore } from '../lib/agentStore'
import { uiStore, CHAT_MIN_WIDTH, FINDINGS_MIN_WIDTH } from '../lib/uiStore'
import { panelsStore, wirePanelsStore, CHAT_TAB } from '../lib/panelsStore'
import { wireExternalAppsStore } from '../lib/externalAppsStore'
import { reposStore } from '../lib/reposStore'
import { useAmbientAnchors } from '../lib/ambientAnchors'
import { panelKeyStr } from '../../../shared/panels'
import type { ChatJumpTarget, FileNode, SessionSummary, UnifiedHit } from '../../../shared/types'
import { classifyCitePath, toRepoNameSet, type CiteTarget } from '../lib/citations'
import type { ModeId } from '../../../shared/modes'
import type { RunOptionSelection } from '../../../shared/runOptions'
import type { PermissionMode } from '../../../shared/settings'
import { caseBarStore, type CaseBarEvent } from '../lib/caseBarStore'

export function CaseWorkspace({
  slug,
  activeMode,
  caseTitle,
  jiraKey,
  jiraSyncedAt,
  onModeSwitched,
  onOpenHit,
  onOpenCitation,
  onOpenFile,
  onOpenCase,
  onOpenRepoFile
}: {
  slug: string
  /** The mode axis the case is currently switched to (`CaseRecord.activeMode`) — the source
   *  of truth for which mode's chat is active, not the session row (Task 3/4: mode moved
   *  from session-scoped to case-scoped). */
  activeMode: ModeId
  /** The case's title — the rail's Jira section shows it as the ticket's title (see
   *  `JiraSection` for why `CaseRecord.title` is the Jira summary for a case made from a
   *  ticket). Empty string while the `cases` list is still loading. */
  caseTitle: string
  /** The case's Jira ticket, for the rail's section (it moved out of the top bar, 2026-08-02).
   *  Passed down from App.tsx's `cases` array — the same already-fetched record `activeMode`
   *  comes from — rather than fetched here: the pill's own refresh writes through
   *  `jira.refreshCase`, and App refetches on the events that change these. Null while the
   *  list is still loading, or when the case has no ticket (the pill renders nothing). */
  jiraKey: string | null
  jiraSyncedAt: string | null
  /** A mode switch persisted `CaseRecord.activeMode` in the DB (ModeSwitcher already called
   *  `cases.setMode`); this tells the parent to refetch its `cases` array so the `activeMode`
   *  prop above stops being stale — same contract as `onStatusChanged`, just for the mode
   *  axis instead of the status axis. Without this, a remount (e.g. home-and-back) would
   *  re-render the switcher off the last-fetched (now wrong) mode. */
  onModeSwitched: () => void
  onOpenHit: (hit: UnifiedHit) => void
  onOpenCitation: (evidenceId: number, start: number, end: number) => void
  onOpenFile: (node: FileNode) => void
  onOpenCase?: (slug: string) => void
  onOpenRepoFile: (repoName: string, relPath: string, start: number, end: number) => void
}): React.JSX.Element {
  const ui = useSyncExternalStore(
    (cb) => uiStore.subscribe(cb),
    () => uiStore.get()
  )
  const dynamic = ui.dynamicTheme
  const anchors = useAmbientAnchors()
  const panels = useSyncExternalStore(
    (cb) => panelsStore.subscribe(cb),
    () => panelsStore.get()
  )
  const dockHost = useRef<HTMLDivElement | null>(null)
  const mainEl = useRef<HTMLElement | null>(null)
  const drag = useRef<{ startX: number; startWidth: number; maxWidth: number } | null>(null)
  const [prefill, setPrefill] = useState('')
  const [sessionId, setSessionId] = useState<number | null>(null)
  // The summaries were previously fetched and thrown away. They are kept now because the
  // composer needs the current chat's pinned provider+model, and the approval card needs
  // that provider's capabilities — both are per-session once several providers are enabled.
  const [sessions, setSessions] = useState<SessionSummary[]>([])
  const [sessionsError, setSessionsError] = useState<string | null>(null)
  const [prPicker, setPrPicker] = useState<PrSearchResult | null>(null)
  // The binding the picker was opened over, so it can warn before silently replacing one —
  // the picker is reachable via "Find PRs" (PrCompanionSection) regardless of whether a PR is
  // already bound, unlike the auto-open-on-review-entry path below (which only fires when
  // nothing is bound yet). Fetched fresh each time the picker opens rather than mirroring
  // PrCompanionSection's own `binding` state, so it is correct whichever caller opened the
  // dialog.
  const [prPickerCurrent, setPrPickerCurrent] = useState<PrBinding | null>(null)
  const [prSearching, setPrSearching] = useState(false)
  const [focusTurn, setFocusTurn] = useState<{
    sessionId: number
    target: ChatJumpTarget
  } | null>(null)
  // case switch: drop the previous case's Analyze suggestion so a re-click of an
  // identical suggestion in the new case isn't a setState no-op, and clear the
  // stale sessionId/error so case A's chat doesn't flash while case B's session
  // list loads — adjust-state-during-render; the composer draft itself resets
  // via key={slug} in ChatPane
  const [lastSlug, setLastSlug] = useState(slug)
  if (slug !== lastSlug) {
    setLastSlug(slug)
    setPrefill('')
    setSessionId(null)
    setSessions([])
    setSessionsError(null)
    // A picker opened over case A (or a `handlePrsFound` lookup still in flight for it) must
    // not survive into case B: CaseWorkspace is never remounted on a slug change (App.tsx
    // renders it with no `key`), so without this an already-open dialog would keep showing
    // A's candidates/binding while `slug` (and so `<PrPickerDialog slug={slug} …/>`, and any
    // "Link selected" click) has already moved on to B — silently retargeting B's binding
    // to a PR found via A's linked repos. `handlePrsFound`'s own stale-guard (below) covers
    // the still-in-flight case; this covers the already-resolved, dialog-already-open case.
    setPrPicker(null)
    setPrPickerCurrent(null)
  }
  // The current slug, read by `handlePrsFound`'s async chain once it resolves — a ref kept
  // current via its own effect (refs may not be written during render) rather than the
  // `sessions.list` effect's cleanup `stale` flag below, because this chain starts from an
  // event callback (PrCompanionSection's "Find PRs"), not from an effect keyed on `[slug]`.
  const currentSlugRef = useRef(slug)
  useEffect(() => {
    currentSlugRef.current = slug
  }, [slug])

  useEffect(() => {
    wireAgentStore()
    // guard against a fast A→B slug switch applying A's late-resolving result
    // after B's effect has already taken over
    let stale = false
    void window.argus.sessions
      .list(slug)
      .then((list) => {
        if (stale) return
        setSessions(list)
        // Reconcile the chat with the case's mode. `activeSessions` is deliberately not
        // persisted (uiStore.ts), so after a restart the remembered id is gone and
        // `list[0]` is the newest chat of ANY mode while `activeMode` comes from the DB.
        // Opening a triage chat under a Review header is not just cosmetic: ModeSwitcher
        // early-returns when the clicked mode is already active, so there would be no way
        // to reach the right chat. Falling back to `list[0]` keeps a case whose mode has
        // no chat yet from rendering nothing.
        const remembered = uiStore.get().activeSessions[slug]
        const matchesMode = (id: number): boolean =>
          list.find((s) => s.id === id)?.mode === activeMode
        const forMode = list.find((s) => s.mode === activeMode)?.id
        setSessionId(
          remembered !== undefined && matchesMode(remembered)
            ? remembered
            : (forMode ?? remembered ?? list[0].id)
        )
      })
      .catch(() => {
        if (stale) return
        setSessionsError('Could not load chat sessions.')
      })
    return () => {
      stale = true
    }
    // activeMode is read as the bootstrap value for this case, not as a reactive dep: a
    // later mode switch is owned end-to-end by handleModeChanged (which refetches the
    // list and selects the session itself), so re-running this would be a duplicate fetch
    // racing that one.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [slug])

  useEffect(() => {
    const off = wirePanelsStore(slug)
    const offExternalApps = wireExternalAppsStore(slug)
    return () => {
      off()
      offExternalApps()
      void window.argus.panels.closeCase(slug)
    }
  }, [slug])

  useEffect(() => {
    void reposStore.load(slug)
  }, [slug])

  async function openInPanel(evidenceId: number, packId: string, windowId: string): Promise<void> {
    await window.argus.panels.open({
      caseSlug: slug,
      packId,
      windowId,
      focus: { evidenceId },
      sessionId
    })
    panelsStore.setActiveTab(panelKeyStr({ caseSlug: slug, packId, windowId }))
  }

  function handleSwitchSession(id: number): void {
    uiStore.setActiveSession(slug, id)
    setSessionId(id)
  }

  /** Re-pin the current chat to a provider instance + model. Applied optimistically so the
   *  picker doesn't lag a round-trip; the main process rebuilds the live session on the
   *  next send (AgentService compares the session's modelKey). */
  function handleModelChange(instanceId: string, model: string): void {
    if (sessionId === null) return
    setSessions((prev) => prev.map((s) => (s.id === sessionId ? { ...s, instanceId, model } : s)))
    void window.argus.sessions.setModel(sessionId, instanceId, model).catch(() => {
      setSessionsError('Could not switch model for this chat.')
    })
  }

  /** Same optimistic-then-persist shape as handleModelChange above: update the local
   *  mirror immediately so the chip reflects the change without a round-trip lag, then
   *  persist it. The chip's own value is DERIVED from this session row (see Composer),
   *  so this refresh is what makes a chip change visible at all. */
  function handleRunOptionsChange(sel: RunOptionSelection[]): void {
    if (sessionId === null) return
    setSessions((prev) => prev.map((s) => (s.id === sessionId ? { ...s, runOptions: sel } : s)))
    void window.argus.sessions.setRunOptions(sessionId, sel).catch(() => {
      setSessionsError('Could not update run options for this chat.')
    })
  }

  function handlePermissionModeChange(mode: PermissionMode): void {
    if (sessionId === null) return
    setSessions((prev) =>
      prev.map((s) => (s.id === sessionId ? { ...s, permissionMode: mode } : s))
    )
    void window.argus.sessions.setPermissionMode(sessionId, mode).catch(() => {
      setSessionsError('Could not update permission mode for this chat.')
    })
  }

  /**
   * The guarded core of "open the PR picker": look up whatever is currently bound, THEN open
   * the picker with it already known — never the reverse — and never for a case the user has
   * since switched away from. Both places that can open `PrPickerDialog` (the auto-search
   * below, on entering review mode with nothing bound, and `handlePrsFound`, from
   * `PrCompanionSection`'s "Find PRs") funnel through this so neither has to remember the
   * guard on its own; a future third caller inherits it too just by calling this.
   *
   * `pr.list` is a genuine IPC round trip, not a microtask; opening the dialog first and
   * setting `currentBinding` only once it resolves would leave a real window where "Link
   * selected" is clickable (a default candidate already selected) while `currentBinding`
   * still reads `null` — `PrPickerDialog.confirm()` cannot tell "nothing bound" apart from
   * "not loaded yet", so a click landing in that window would skip the replace-confirmation
   * entirely (or — for the auto-search path specifically, which never populated
   * `currentBinding` at all before this — skip it on EVERY link, not just a timing window).
   * A failed lookup still opens the picker (degrading to "nothing bound" rather than
   * blocking it — the confirm is a safety net, not a gate the picker depends on to
   * function), it just does so no earlier than a successful one would.
   *
   * `CaseWorkspace` is never remounted on a slug change (`App.tsx` renders it with no
   * `key`), so a case switch started while this is in flight would otherwise land ITS
   * case-A result on the now-current case B when it resolves. `forSlug`/`currentSlugRef`
   * (same purpose as the `sessions.list` effect's `stale` flag above, expressed as a ref
   * because this starts from an event callback / a `.then` continuation rather than an
   * effect keyed on `[slug]`) drops it instead — and the `slug !== lastSlug` block above
   * clears an already-open dialog for the OLD case, which a guard on the not-yet-resolved
   * lookup alone can't reach.
   *
   * Returns its promise so a caller that wants "busy until the dialog is actually up" (like
   * `PrCompanionSection`'s `searching` flag, via `handlePrsFound`) can await it — otherwise a
   * second search could start (and later resolve) before the first one's dialog had opened,
   * swapping `result`/`currentBinding` out from under an already-rendered picker.
   */
  function openPrPicker(forSlug: string, result: PrSearchResult): Promise<void> {
    return window.argus.pr
      .list(forSlug)
      .then((bound) => bound[0] ?? null)
      .catch(() => null)
      .then((current) => {
        if (currentSlugRef.current !== forSlug) return // the case switched while this was in flight
        setPrPickerCurrent(current)
        setPrPicker(result)
      })
  }

  /** ModeSwitcher already called cases.setMode itself (switching the case's active mode,
   *  and creating that mode's chat if it didn't exist yet). Follow the user to that chat —
   *  same path a search-hit jump or the session-list picker uses — refresh the session
   *  list so a newly-created chat appears there, and tell the parent to refetch its case
   *  list so the `activeMode` prop this component renders off of stops being stale (see
   *  the onModeSwitched doc comment above; no local mirror of the mode is kept here). */
  function handleModeChanged(mode: ModeId, newSessionId: number): void {
    // sessionsError blanks the whole chat, so a stale one from an earlier failed switch
    // would keep hiding the transcript of the switch that just succeeded.
    setSessionsError(null)
    handleSwitchSession(newSessionId)
    onModeSwitched()
    void window.argus.sessions
      .list(slug)
      .then((list) => setSessions(list))
      .catch(() => setSessionsError('Could not load chat sessions.'))
    // Entering review with nothing bound yet is the one moment discovery is worth ~5s of
    // gh: offer the picker. It runs AFTER the switch resolved, so the chat opens
    // immediately and a failed search degrades to manual linking in the Pull request rail.
    // Later entries go straight to the chat; "Link PR" there is the re-run path.
    if (mode !== 'review') return
    const forSlug = slug
    void window.argus.pr
      .list(forSlug)
      .then((bound) => {
        if (bound.length) return null
        // ~5s of gh with nothing on screen reads as a hang; say what is happening
        setPrSearching(true)
        return window.argus.pr.search(forSlug)
      })
      // openPrPicker re-checks the binding (rather than trusting the `bound.length` check
      // above, which by now is a whole `gh` search old) and re-checks the slug — see its
      // doc comment for why both re-checks matter here, not just for handlePrsFound.
      //
      // `candidates.length` gates it because THIS caller's search is unrequested — the user
      // switched modes, they did not ask about pull requests. A result with nothing to pick
      // has no question to put to them, so raising the modal over the chat that just opened
      // (with only Cancel to click) is pure interruption: a case whose linked repo `gh`
      // cannot see greeted every review switch with a wall of red. The error is not lost —
      // "Find PRs" in the Pull request rail re-runs the same search and DOES render both the
      // error and empty states, because there the user asked.
      .then((r) => {
        if (!r) return undefined
        // not on screen, but not thrown away either — same channel PrCompanionSection's own
        // background status refresh reports through
        if (r.error) console.warn(`[pr] review-entry search failed for ${forSlug}: ${r.error}`)
        return r.candidates.length > 0 ? openPrPicker(forSlug, r) : undefined
      })
      .catch(() => undefined)
      .finally(() => setPrSearching(false))
  }

  /** ModeSwitcher surfaces its own load/switch failures here rather than swallowing them —
   *  same error line handleModelChange's .catch uses above. */
  function handleModeError(message: string): void {
    setSessionsError(message)
  }

  // The bar's ModeSwitcher calls cases.setMode itself; everything that has to happen after
  // it — select the new chat, refetch the session list, offer the PR picker — lives here,
  // behind race guards not worth moving for a layout change. `handleModeChanged` closes over
  // fresh state on every render, so the subscription reads it through a ref rather than
  // capturing one render's copy. Same idiom AmbientCanvas uses for its own latest-props ref.
  const onBarEvent = useRef<(event: CaseBarEvent) => void>(() => undefined)
  useEffect(() => {
    onBarEvent.current = (event) => {
      if (event.kind === 'mode-switched') handleModeChanged(event.mode, event.sessionId)
      else handleModeError(event.message)
    }
  })
  useEffect(() => {
    return caseBarStore.onEventFor(slug, (event) => onBarEvent.current(event))
  }, [slug])

  // Down-channel: the bar cannot know review's PR search is still running, because the search
  // runs here and outlives the cases.setMode the bar awaited.
  useEffect(() => {
    caseBarStore.publish({
      slug,
      busyMode: prSearching ? 'review' : null,
      statusText: prSearching ? 'Searching for pull requests…' : null
    })
    // Navigating home (or away to another case) unmounts this workspace; without clearing the
    // store here, the last-published busy state survives — e.g. `Searching…` from a review PR
    // search that outlives the unmount — and reopening the case renders that stale state.
    return () => {
      caseBarStore.publish({ slug: null, busyMode: null, statusText: null })
    }
  }, [slug, prSearching])

  /** Mirrors ReviewRunButton: compose in main (it owns the binding and worktree path), then
   *  send through the ordinary agent path so cancel/queue/mirror behave normally. A plain
   *  function, like the handlers around it — this component uses no useCallback and
   *  PrCompanionSection is not memoized, so a stable identity would buy nothing. */
  async function analyzeCheck(checkName: string): Promise<void> {
    if (sessionId === null) return
    try {
      const prompt = await window.argus.review.composeCiPrompt(slug, sessionId, checkName)
      await window.argus.agent.send(slug, sessionId, prompt, true)
    } catch (err) {
      handleModeError((err as Error).message)
    }
  }

  /** PrCompanionSection's "Find PRs" result handler — see `openPrPicker`'s doc comment for
   *  what this guards against. */
  function handlePrsFound(result: PrSearchResult): Promise<void> {
    return openPrPicker(slug, result)
  }

  // a search hit's jump target: switch to its session via the same path as a
  // normal switcher click, then hand ChatPane the message to scroll to + flash
  function handleJumpToTurn(targetSessionId: number, target: ChatJumpTarget): void {
    if (targetSessionId !== sessionId) handleSwitchSession(targetSessionId)
    setFocusTurn({ sessionId: targetSessionId, target })
  }

  useEffect(() => {
    if (sessionId === null) return
    // restore the persisted transcript after an app restart
    void window.argus.agent
      .history(slug, sessionId)
      .then((events) => agentStore.hydrate(slug, sessionId, events))
  }, [slug, sessionId])

  async function handleCite(cite: CiteTarget): Promise<void> {
    const names = toRepoNameSet(reposStore.get(slug).names)
    if (classifyCitePath(cite.relPath, names) === 'repo') {
      const slash = cite.relPath.indexOf('/')
      onOpenRepoFile(
        cite.relPath.slice(0, slash),
        cite.relPath.slice(slash + 1),
        cite.start,
        cite.end
      )
      return
    }
    const list = await window.argus.evidence.list(slug)
    const rec = list.find((e) => e.relPath === cite.relPath)
    if (rec) onOpenCitation(rec.id, cite.start, cite.end)
  }

  return (
    <div className="relative flex min-h-0 flex-1 flex-col">
      {/* The dynamic theme's light band. It used to borrow the case header's box; with that
          header merged into the bar this is what it was always describing — the top 44px of the
          case view, lit from the left, under where the case anchor now sits. Anchoring to a real
          component instead would couple the band to that component's box and break the next time
          one is restyled.

          The canvas is a single `position: fixed` layer at the window's top edge, and
          `anchorRect` measures every anchor with `getBoundingClientRect` — viewport-relative, not
          relative to any wrapper — so the two anchors need no common ancestor: this one lives
          here, and Settings' equivalents live in TopBar, a sibling of DynamicScope entirely.
          That is what lets one canvas light the chrome AND the view below it, rather than needing
          a second canvas behind the bar.

          setCutoff/setLight are the claim/release ref callbacks from lib/ambientAnchors.ts, not
          bare `useState` setters: each returns a cleanup scoped to the node it attached, so a
          late detach from a departing sibling (Settings' TopBar, notably) cannot null out an
          anchor this view has since claimed. Still ref callbacks underneath, so react-hooks/refs
          is a false positive here. */}
      <div
        aria-hidden="true"
        data-testid="ambient-band"
        className="pointer-events-none absolute inset-x-0 top-0 h-11"
        // eslint-disable-next-line react-hooks/refs
        ref={anchors.setCutoff}
      >
        {/* eslint-disable-next-line react-hooks/refs */}
        <div ref={anchors.setLight} className="h-full w-64" />
      </div>
      <div className="flex min-h-0 flex-1">
        {ui.evidenceCollapsed ? (
          <button
            aria-label="Expand workspace"
            title="Expand workspace"
            /* Top-aligned, not centred: `pt-3` + the `h-6` icon box below reproduce the expanded
               rail's `p-3` inset and chrome-row height exactly, so collapsing slides the icon
               sideways instead of dropping it to mid-window — the pointer is still on it. */
            className="flex w-6 shrink-0 flex-col items-center justify-start gap-2 border-r border-hair bg-void pt-3 text-mute transition-colors hover:bg-hi hover:text-ink"
            onClick={() => uiStore.setEvidenceCollapsed(false)}
          >
            <span className="flex h-6 shrink-0 items-center">
              <PanelLeft size={14} strokeWidth={1.5} />
            </span>
            <span className="rotate-180 font-mono text-[10.5px] uppercase tracking-[0.1em] [writing-mode:vertical-rl]">
              Workspace
            </span>
          </button>
        ) : (
          <aside
            className={`flex w-80 shrink-0 flex-col gap-3 overflow-hidden border-r border-hair p-3 ${dynamic ? 'dyn-rail' : 'bg-void'}`}
          >
            {/* Rail chrome, and deliberately NOT inside the scroll box below.
                The toggle used to ride ReposSection's header (as `headerExtra`), which made its
                y a fact about the rail's *content*: a case with a Jira ticket pushed it down by
                the whole ticket card, and scrolling the rail took it off screen entirely — while
                its opposite number in the findings rail never moved. Here it is the rail's own
                first row, so it sits at a fixed y whatever the sections do, and FindingsPane's
                header row is built to the same `h-6` at the same `p-3` inset so the two line up
                exactly. Flush to the OUTER edge on both sides, i.e. mirrored: the icon then sits
                on the edge it collapses into, and stops reading as a Repos affordance.
                "Workspace", not "Evidence" (user-directed, 2026-08-02): the rail carries the
                ticket, the repos and the PR as well, and CaseFiles below already owns the word
                Evidence for the thing that actually is evidence. */}
            <div className="flex h-6 shrink-0 items-center gap-1.5">
              <IconBtn
                size="sm"
                aria-label="Collapse workspace"
                title="Collapse workspace"
                onClick={() => uiStore.setEvidenceCollapsed(true)}
              >
                <PanelLeft size={14} strokeWidth={1.5} />
              </IconBtn>
              <SectionLabel>Workspace</SectionLabel>
            </div>
            {/* The rail itself no longer scrolls (CaseFiles below needs flex-1 to mean
                something), so this wrapper keeps these naturally-growing sections — an
                unbounded repo list, PR checks, similar-case hits — reachable on a short
                window or a case with a lot of any of them, instead of silently clipping
                against the rail's overflow-hidden.
                Deliberately NOT shrink-0: flex-shrink:0 would pin this box to its full
                content height, so it would never become shorter than its content and
                overflow-y-auto would never have anything to scroll — verified live over
                CDP (see task-6-report.md) that content past the rail's height was then
                clipped by the aside's overflow-hidden with no way to reach it. Leaving
                the default shrink lets this box get bounded by the available space, at
                which point overflow-y-auto genuinely scrolls; CaseFiles' own min-h-32
                flex-1 (below) gives the card a floor it can't be squeezed under (flex
                distributes negative space by scaled shrink factor, and a flex-basis:0%
                child would otherwise absorb none of it, i.e. get squeezed to 0), which
                is what forces this box to give up space first instead. */}
            <div className="flex min-h-0 flex-col gap-3 overflow-y-auto">
              {/* The ticket, first: it is the case's origin, so it reads above the material the
                  case accumulated. key: reset the refresh phase on a case switch, exactly as the
                  top bar's copy did. Renders nothing when the case has no ticket. */}
              <JiraSection
                key={slug}
                slug={slug}
                jiraKey={jiraKey}
                title={caseTitle}
                syncedAt={jiraSyncedAt}
              />
              {/* key: remount on case switch. Pending/error chips live in ReposSection's own
                  usePendingList() state, which is component-instance state, not derived from
                  props — without a key, a failed unlink in case A (e.g. a locked worktree)
                  would leave an error chip that survives the switch to case B and renders
                  underneath case B's freshly reloaded repo list. This keys on `slug` alone, not
                  `${slug}:${activeMode}` (unlike CaseFiles above): the same repos show in both
                  modes (only the unlink/graph affordances differ), so keying on mode would
                  discard a good fetch — and the `git status --porcelain` spawns behind it — on
                  every mode toggle. */}
              <ReposSection key={slug} slug={slug} mode={activeMode} />
              {/* key: remount on case switch. `linkingRef`/`linkingPr`/`prDraft`/`prError` are
                  component-instance state (Task 5's optimistic in-flight-link row), not derived
                  from props — without a key, a `pr:link` still running when the user switches to
                  another case (it does a real `git fetch` + `worktree add`, easily tens of
                  seconds) would keep rendering case A's PR identity under case B, suppressing
                  B's own empty state. Same reasoning as ReposSection's key just above — prefixed
                  (unlike ReposSection's bare `slug`) because the two are siblings under the same
                  parent: React requires keys to be unique among siblings regardless of component
                  type, and a bare `key={slug}` on both here collided, silently defeating
                  ReposSection's own remount instead of adding this one. */}
              <PrCompanionSection
                key={`pr:${slug}`}
                slug={slug}
                mode={activeMode}
                onAnalyze={(checkName) => void analyzeCheck(checkName)}
                onPrsFound={handlePrsFound}
              />
              {activeMode !== 'review' && <SimilarCasesCard slug={slug} onOpenCase={onOpenCase} />}
            </div>
            {/* key: reset per-case state (scan result, collapsed dirs, parsing set) when
                switching cases or modes — investigation evidence and review artifacts are
                disjoint lists */}
            <CaseFiles
              key={`${slug}:${activeMode}`}
              caseSlug={slug}
              label={activeMode === 'review' ? 'Code review artifacts' : 'Evidence'}
              mode={activeMode}
              onSuggest={setPrefill}
              onOpenFile={onOpenFile}
              panelDecls={panels.decls}
              onOpenInPanel={(id, packId, windowId) => void openInPanel(id, packId, windowId)}
              // Investigation only, as before — review mode's artifacts are not in the
              // investigation search index and the section has no field.
              search={
                activeMode !== 'review' ? (
                  <SearchBar caseSlug={slug} onOpen={onOpenHit} />
                ) : undefined
              }
            />
          </aside>
        )}
        <main
          ref={mainEl}
          className="flex flex-1 flex-col overflow-hidden"
          style={{ minWidth: CHAT_MIN_WIDTH }}
        >
          <PanelTabStrip
            slug={slug}
            sessionId={sessionId}
            activeTab={panels.activeTab}
            onSelect={(t) => panelsStore.setActiveTab(t)}
            action={
              activeMode === 'review' ? (
                <ReviewRunButton slug={slug} sessionId={sessionId} onError={handleModeError} />
              ) : undefined
            }
          />
          <div className="relative min-h-0 flex-1">
            <div
              className={`flex h-full min-h-0 flex-col ${panels.activeTab === CHAT_TAB ? '' : 'hidden'}`}
            >
              {sessionsError && <p className="p-3 text-xs text-danger">{sessionsError}</p>}
              {!sessionsError && sessionId !== null && (
                <ChatPane
                  slug={slug}
                  sessionId={sessionId}
                  session={sessions.find((s) => s.id === sessionId) ?? null}
                  onModelChange={handleModelChange}
                  onRunOptionsChange={handleRunOptionsChange}
                  onPermissionModeChange={handlePermissionModeChange}
                  onSwitchSession={handleSwitchSession}
                  onCite={(c) => void handleCite(c)}
                  onJumpToTurn={handleJumpToTurn}
                  focusTarget={focusTurn?.target ?? null}
                  onFocusConsumed={() => setFocusTurn(null)}
                  prefill={prefill}
                />
              )}
            </div>
            {/* The active docked panel's native view is painted over this host by PanelDock. */}
            <div
              ref={dockHost}
              className={`absolute inset-0 ${panels.activeTab === CHAT_TAB ? 'hidden' : ''}`}
            />
            <PanelDock hostRef={dockHost} />
          </div>
        </main>
        {ui.findingsCollapsed ? (
          <button
            aria-label="Expand findings"
            title="Expand findings"
            /* Top-aligned for the same reason as the workspace strip opposite — see there. */
            className="flex w-6 shrink-0 flex-col items-center justify-start gap-2 border-l border-hair bg-void pt-3 text-mute transition-colors hover:bg-hi hover:text-ink"
            onClick={() => uiStore.setFindingsCollapsed(false)}
          >
            <span className="flex h-6 shrink-0 items-center">
              <PanelRight size={14} strokeWidth={1.5} />
            </span>
            <span className="rotate-180 font-mono text-[10.5px] uppercase tracking-[0.1em] [writing-mode:vertical-rl]">
              Findings
            </span>
          </button>
        ) : (
          <>
            <div
              role="separator"
              aria-orientation="vertical"
              aria-label="Resize findings pane"
              className="w-1 shrink-0 cursor-col-resize bg-transparent transition-colors hover:bg-signal/40"
              onPointerDown={(e) => {
                drag.current = {
                  startX: e.clientX,
                  startWidth: ui.findingsWidth,
                  maxWidth:
                    ui.findingsWidth +
                    // `?? Infinity` is defensive only: <main> is unconditionally rendered
                    // whenever this separator exists, so mainEl.current is never null here.
                    Math.max(0, (mainEl.current?.clientWidth ?? Infinity) - CHAT_MIN_WIDTH)
                }
                e.currentTarget.setPointerCapture?.(e.pointerId)
              }}
              onPointerMove={(e) => {
                if (!drag.current) return
                uiStore.setFindingsWidth(
                  Math.min(
                    drag.current.maxWidth,
                    drag.current.startWidth + (drag.current.startX - e.clientX)
                  )
                )
              }}
              onPointerUp={() => {
                drag.current = null
              }}
            />
            <aside
              className={`flex flex-col border-l border-hair p-3 ${dynamic ? 'dyn-rail' : 'bg-void'}`}
              style={{ width: ui.findingsWidth, minWidth: FINDINGS_MIN_WIDTH }}
            >
              {/* key: remount on case switch. Findings are fetched once per case and filtered
                  by mode client-side, so this keys on `slug` alone, not `${slug}:${activeMode}`
                  (unlike CaseFiles above) — keying on mode would discard a good fetch on every
                  mode toggle. The remount is what guarantees no cross-case findings leak now
                  that a rejected fetch no longer clears state (see FindingsPane's list().catch
                  comment): without it, this would stay a single long-lived instance across case
                  switches, and a failed fetch for the new case would leave the old case's
                  findings on screen under the new slug. The remount also resets the per-case
                  expandedId/selected/layerFilter state. */}
              <FindingsPane
                key={slug}
                slug={slug}
                sessionId={sessionId}
                activeMode={activeMode}
                onCite={(c) => void handleCite(c)}
              />
            </aside>
          </>
        )}
      </div>
      {prPicker && (
        <PrPickerDialog
          slug={slug}
          result={prPicker}
          currentBinding={prPickerCurrent}
          onClose={() => {
            setPrPicker(null)
            setPrPickerCurrent(null)
          }}
        />
      )}
    </div>
  )
}
