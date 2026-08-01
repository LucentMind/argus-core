import { useEffect, useRef, useState } from 'react'
import { ChevronDown, Loader2 } from 'lucide-react'
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
  const ref = useRef<HTMLDivElement>(null)

  function toggle(id: ReviewLayerId): void {
    setPinned((prev) => (prev.includes(id) ? prev.filter((x) => x !== id) : [...prev, id]))
  }

  // Mirrors MenuButton's own open-sync effect (ui.tsx:194-200): keep panelsStore's
  // launcherOpen in lockstep with `open` from an effect, not from inside the setOpen
  // updater — updaters must stay pure (StrictMode double-invokes them in dev), and
  // notifying an external store from one risks doing so during the render phase. This
  // also covers switching out of review mode while the dropdown is open, which unmounts
  // the whole button (CaseWorkspace stops passing it as `action`) without an
  // onClick(false) — the cleanup below fires false on unmount too, so launcherOpen can
  // never get stuck true.
  useEffect(() => {
    panelsStore.setLauncherOpen(open)
    return () => {
      if (open) panelsStore.setLauncherOpen(false)
    }
  }, [open])

  // Mirrors MenuButton's outside-mousedown + Escape listeners (ui.tsx:201-215) so the
  // dropdown — and so the docked panel it occludes — is self-clearing instead of staying
  // blank until the user clicks the trigger again.
  useEffect(() => {
    if (!open) return
    const onDoc = (e: MouseEvent): void => {
      if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false)
    }
    const onKey = (e: KeyboardEvent): void => {
      if (e.key === 'Escape') setOpen(false)
    }
    document.addEventListener('mousedown', onDoc)
    document.addEventListener('keydown', onKey)
    return () => {
      document.removeEventListener('mousedown', onDoc)
      document.removeEventListener('keydown', onKey)
    }
  }, [open])

  async function run(): Promise<void> {
    if (sessionId === null || running) return
    setRunning(true)
    setOpen(false)
    try {
      // Ordered by the registry, not by click order, so the prompt reads consistently.
      const layers = REVIEW_LAYER_ORDER.filter((id) => pinned.includes(id))
      const prompt = await window.argus.review.composeRunPrompt(slug, sessionId, layers)
      await window.argus.agent.send(slug, sessionId, prompt, true)
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
          className="absolute right-0 top-full z-10 mt-1 flex w-64 flex-col gap-1 rounded-r2 border border-hair bg-panel p-2 shadow-lg"
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
    </div>
  )
}
