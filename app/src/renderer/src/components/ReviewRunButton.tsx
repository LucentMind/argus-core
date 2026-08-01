import { useEffect, useRef, useState } from 'react'
import { ChevronDown, Loader2, X } from 'lucide-react'
import { REVIEW_LAYERS, REVIEW_LAYER_ORDER, type ReviewLayerId } from '../../../shared/reviewLayers'
import { panelsStore } from '../lib/panelsStore'

/**
 * Starts a layered review. Auto by default: an empty pin list means the agent decides which
 * layers apply. The dropdown pins a subset for the runs where the user already knows.
 *
 * Composition happens in main (it owns the PR binding and worktree path) and the composed text
 * goes out through the ordinary agent.send path, so cancel/queue/mirror behave exactly as they
 * do for a typed message.
 */
export function ReviewRunButton({
  slug,
  sessionId,
  onError
}: {
  slug: string
  sessionId: number | null
  onError: (message: string) => void
}): React.JSX.Element {
  const [pinned, setPinned] = useState<ReviewLayerId[]>([])
  const [open, setOpen] = useState(false)
  const [running, setRunning] = useState(false)
  const [needsPr, setNeedsPr] = useState(false)
  const ref = useRef<HTMLDivElement>(null)

  function toggle(id: ReviewLayerId): void {
    setPinned((prev) => (prev.includes(id) ? prev.filter((x) => x !== id) : [...prev, id]))
  }

  /** Either popover is DOM sitting in the panel tab strip's row, so both need the treatment
   *  below — a docked panel's native WebContentsView would otherwise paint straight over them. */
  const popoverOpen = open || needsPr

  function closePopovers(): void {
    setOpen(false)
    setNeedsPr(false)
  }

  // Mirrors MenuButton's own open-sync effect (ui.tsx:194-200): keep panelsStore's
  // launcherOpen in lockstep with the popovers from an effect, not from inside the setOpen
  // updater — updaters must stay pure (StrictMode double-invokes them in dev), and
  // notifying an external store from one risks doing so during the render phase. This
  // also covers switching out of review mode while one is open, which unmounts
  // the whole button (CaseWorkspace stops passing it as `action`) without an
  // onClick(false) — the cleanup below fires false on unmount too, so launcherOpen can
  // never get stuck true.
  useEffect(() => {
    panelsStore.setLauncherOpen(popoverOpen)
    return () => {
      if (popoverOpen) panelsStore.setLauncherOpen(false)
    }
  }, [popoverOpen])

  // Mirrors MenuButton's outside-mousedown + Escape listeners (ui.tsx:201-215) so a popover —
  // and so the docked panel it occludes — is self-clearing instead of staying blank until the
  // user clicks the trigger again. This is what makes it safe for the no-PR notice to occlude
  // at all: dismissing it must not depend on the user finding its little × first.
  useEffect(() => {
    if (!popoverOpen) return
    const onDoc = (e: MouseEvent): void => {
      if (ref.current && !ref.current.contains(e.target as Node)) closePopovers()
    }
    const onKey = (e: KeyboardEvent): void => {
      if (e.key === 'Escape') closePopovers()
    }
    document.addEventListener('mousedown', onDoc)
    document.addEventListener('keydown', onKey)
    return () => {
      document.removeEventListener('mousedown', onDoc)
      document.removeEventListener('keydown', onKey)
    }
  }, [popoverOpen])

  async function run(): Promise<void> {
    if (sessionId === null || running) return
    setRunning(true)
    setOpen(false)
    setNeedsPr(false)
    try {
      // Ordered by the registry, not by click order, so the prompt reads consistently.
      const layers = REVIEW_LAYER_ORDER.filter((id) => pinned.includes(id))
      const composed = await window.argus.review.composeRunPrompt(slug, sessionId, layers)
      // Not an error path: nothing bound yet is a step the user has not taken, so it is
      // answered here with the next step and deliberately kept away from `onError` — that
      // sets CaseWorkspace's sessionsError, which replaces the whole transcript.
      if (!composed.ok) {
        setNeedsPr(true)
        return
      }
      await window.argus.agent.send(slug, sessionId, composed.prompt, true)
    } catch (err) {
      onError((err as Error).message)
    } finally {
      setRunning(false)
    }
  }

  return (
    <div className="relative flex items-center" ref={ref}>
      <button
        type="button"
        aria-label="Run review"
        disabled={sessionId === null || running}
        aria-busy={running}
        onClick={() => void run()}
        className="flex items-center gap-1 rounded-l-r2 border border-hair px-2.5 py-1 text-xs text-ink transition-colors hover:bg-signal/10 disabled:opacity-50"
      >
        {running && <Loader2 size={11} className="animate-spin" aria-hidden="true" />}
        Run review
      </button>
      <button
        type="button"
        aria-label="Choose review layers"
        aria-expanded={open}
        disabled={running}
        onClick={() => setOpen((v) => !v)}
        className="rounded-r-r2 border border-l-0 border-hair px-1.5 py-1 text-mute transition-colors hover:text-ink disabled:opacity-50"
      >
        <ChevronDown size={12} />
      </button>
      {open && (
        <div
          role="group"
          aria-label="Review layers"
          /**
           * `left-0`, not `right-0` (2026-08-01). This button lives at the LEFT of the panel tab
           * strip, inside `CaseWorkspace`'s `<main className="… overflow-hidden">`. A
           * right-anchored 16rem panel therefore extended past main's left edge and was *clipped*
           * by that overflow — the visible symptom was a card with every line's first words
           * sheared off at a hard vertical edge. Opening rightward keeps it inside the clip box.
           * Same reasoning as `MenuButton`'s own `align="left"`, which documents this trap.
           *
           * `overlay-menu` (main.css) replaces `border-hair bg-panel shadow-lg`: one popup
           * material for every popup, rather than each one naming its own surface.
           */
          className="absolute left-0 top-full z-30 mt-1 flex w-64 flex-col gap-1 rounded-r2 overlay-menu p-2"
        >
          <p className="text-[10px] text-mute">
            Nothing pinned — the agent picks the layers this PR needs.
          </p>
          {REVIEW_LAYER_ORDER.map((id) => (
            <label key={id} className="flex items-center gap-2 text-xs text-ink">
              <input type="checkbox" checked={pinned.includes(id)} onChange={() => toggle(id)} />
              {REVIEW_LAYERS[id].label}
            </label>
          ))}
        </div>
      )}
      {/* Deliberately not `text-danger`, and deliberately rendered here rather than handed to
          onError: a review with no PR linked yet is a prompt, not a failure. It sits under the
          button it belongs to, so the transcript behind it stays on screen. */}
      {needsPr && (
        <div
          role="status"
          // `left-0` + `overlay-menu` for the same two reasons as the layer picker above.
          className="absolute left-0 top-full z-30 mt-1 flex w-72 items-start gap-2 rounded-r2 overlay-menu p-2"
        >
          <p className="flex-1 text-[11px] leading-relaxed text-mute">
            No pull request is linked to this case yet — use{' '}
            <span className="text-ink">Link PR</span> in the Pull request rail, then run the review.
          </p>
          <button
            type="button"
            aria-label="Dismiss"
            onClick={() => setNeedsPr(false)}
            className="text-mute transition-colors hover:text-ink"
          >
            <X size={12} />
          </button>
        </div>
      )}
    </div>
  )
}
