import { useCallback, useEffect, useRef } from 'react'
import { clampSplitFraction, type ViewMode } from '../../lib/editorPrefs'

export interface EditorPaneProps {
  viewMode: ViewMode
  splitFraction: number
  onSplitFraction: (fraction: number) => void
  /** The `CodeSurface` element. Always rendered — see the hidden-not-unmounted note below. */
  surface: React.ReactNode
  preview: React.ReactNode
}

/**
 * Spec §5.5's three view modes and the draggable splitter.
 *
 * The surface is **hidden, never unmounted**, in preview mode. Unmounting CodeMirror discards
 * undo history and cursor position, so flipping to Preview and back would quietly cost the user
 * their undo stack — the same class of bug as Increment 2's Finding 1, which is why the wrapper
 * carries `inert` and `aria-hidden` too: Tailwind's `hidden` is only `display:none` where a
 * stylesheet is loaded, which is not the case under jsdom.
 *
 * The preview is genuinely unmounted when not shown: it is derived from the document and holds
 * nothing worth preserving.
 */
export function EditorPane({
  viewMode,
  splitFraction,
  onSplitFraction,
  surface,
  preview
}: EditorPaneProps): React.JSX.Element {
  const rowRef = useRef<HTMLDivElement | null>(null)
  const dragging = useRef(false)

  const onPointerMove = useCallback(
    (e: PointerEvent) => {
      const row = rowRef.current
      if (!dragging.current || !row) return
      const rect = row.getBoundingClientRect()
      if (rect.width === 0) return
      onSplitFraction(clampSplitFraction((e.clientX - rect.left) / rect.width))
    },
    [onSplitFraction]
  )

  useEffect(() => {
    const stop = (): void => {
      dragging.current = false
    }
    // Listeners on `window`, not the splitter: a fast drag outruns a 6px-wide element, and
    // pointer events stop arriving the moment the cursor leaves it.
    window.addEventListener('pointermove', onPointerMove)
    window.addEventListener('pointerup', stop)
    return () => {
      window.removeEventListener('pointermove', onPointerMove)
      window.removeEventListener('pointerup', stop)
    }
  }, [onPointerMove])

  const showPreview = viewMode !== 'editor'
  const hideSurface = viewMode === 'preview'

  return (
    <div ref={rowRef} className="flex min-h-0 min-w-0 flex-1">
      <div
        className={hideSurface ? 'hidden' : 'flex min-h-0 min-w-0 flex-col'}
        style={viewMode === 'split' ? { flex: `0 0 ${splitFraction * 100}%` } : { flex: '1 1 0%' }}
        inert={hideSurface}
        aria-hidden={hideSurface || undefined}
      >
        {surface}
      </div>

      {viewMode === 'split' && (
        <div
          role="separator"
          aria-label="Resize preview"
          aria-orientation="vertical"
          tabIndex={0}
          onPointerDown={() => {
            dragging.current = true
          }}
          onKeyDown={(e) => {
            // A splitter that only responds to a pointer is unreachable by keyboard, and this
            // one gates the preview's width — the reason the split mode exists.
            if (e.key === 'ArrowLeft') onSplitFraction(clampSplitFraction(splitFraction - 0.05))
            if (e.key === 'ArrowRight') onSplitFraction(clampSplitFraction(splitFraction + 0.05))
          }}
          className="w-1.5 shrink-0 cursor-col-resize bg-hair transition-colors hover:bg-signal/40 focus:bg-signal/40 focus:outline-none"
        />
      )}

      {showPreview && <div className="flex min-h-0 min-w-0 flex-1 flex-col">{preview}</div>}
    </div>
  )
}
