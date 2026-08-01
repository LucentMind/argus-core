import { noticeStore, useNotices } from '../lib/noticeStore'

/**
 * Renders the single most recent {@link noticeStore} entry, inline in the case header's
 * info slot (right of the mode switch) — not a stack, and not a fixed-position overlay.
 *
 * Bottom-right toasts went unnoticed: the action that queues one (Export, in the top-left
 * case menu) is nowhere near there. Living in the header instead means it's on-screen right
 * where the user is already looking, and it truncates rather than pushing the mode switch or
 * the open-case tab strip around.
 */
export function HeaderNotice(): React.JSX.Element | null {
  const { notices } = useNotices()
  const current = notices[notices.length - 1]
  if (!current) return null
  return (
    <button
      type="button"
      aria-label={`Dismiss: ${current.message}`}
      onClick={() => noticeStore.dismiss(current.id)}
      className={`max-w-80 truncate text-left text-xs ${
        current.tone === 'danger' ? 'text-danger' : 'text-dim'
      }`}
    >
      {current.message}
    </button>
  )
}
