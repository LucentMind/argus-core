import { toastStore, useToasts } from '../lib/toastStore'

/**
 * Renders the {@link toastStore} queue. Mounted once at the app root beside `ConfirmHost`.
 *
 * Bottom-right, so it never covers the header this whole change exists to keep still.
 * `pointer-events-none` on the stack with `pointer-events-auto` on each toast means the
 * gaps between toasts stay click-through to the workspace underneath.
 */
export function ToastHost(): React.JSX.Element | null {
  const { toasts } = useToasts()
  if (toasts.length === 0) return null
  return (
    <div
      role="status"
      aria-live="polite"
      className="pointer-events-none fixed bottom-4 right-4 z-50 flex flex-col items-end gap-2"
    >
      {toasts.map((t) => (
        <button
          key={t.id}
          type="button"
          aria-label={`Dismiss: ${t.message}`}
          onClick={() => toastStore.dismiss(t.id)}
          className={`pointer-events-auto max-w-96 rounded-r2 border bg-overlay px-3 py-2 text-left text-xs shadow-lg transition-colors ${
            t.tone === 'danger'
              ? 'border-danger/40 text-danger hover:bg-hi'
              : 'border-hair2 text-dim hover:bg-hi hover:text-ink'
          }`}
        >
          {t.message}
        </button>
      ))}
    </div>
  )
}
