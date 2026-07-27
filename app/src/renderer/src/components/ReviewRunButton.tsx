import { useState } from 'react'
import { ChevronDown, Loader2 } from 'lucide-react'
import { REVIEW_LAYERS, REVIEW_LAYER_ORDER, type ReviewLayerId } from '../../../shared/reviewLayers'

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

  function toggle(id: ReviewLayerId): void {
    setPinned((prev) => (prev.includes(id) ? prev.filter((x) => x !== id) : [...prev, id]))
  }

  async function run(): Promise<void> {
    if (sessionId === null || running) return
    setRunning(true)
    setOpen(false)
    try {
      // Ordered by the registry, not by click order, so the prompt reads consistently.
      const layers = REVIEW_LAYER_ORDER.filter((id) => pinned.includes(id))
      const prompt = await window.argus.review.composeRunPrompt(slug, sessionId, layers)
      await window.argus.agent.send(slug, sessionId, prompt)
    } catch (err) {
      onError((err as Error).message)
    } finally {
      setRunning(false)
    }
  }

  return (
    <div className="relative flex items-center">
      <button
        type="button"
        disabled={sessionId === null || running}
        aria-busy={running}
        onClick={() => void run()}
        className="flex items-center gap-1 rounded-l-r2 border border-hair px-2.5 py-1 text-xs text-ink transition-colors hover:bg-signal/10 disabled:opacity-50"
      >
        {running && <Loader2 size={11} className="animate-spin" aria-hidden="true" />}
        Review
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
              <input
                type="checkbox"
                checked={pinned.includes(id)}
                onChange={() => toggle(id)}
                aria-label={REVIEW_LAYERS[id].label}
              />
              {REVIEW_LAYERS[id].label}
            </label>
          ))}
        </div>
      )}
    </div>
  )
}
