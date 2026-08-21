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
      // The first-run mirror notice (Task 7) runs ~132 characters, and at the old `max-w-80`
      // (320px) single-line truncation only its first ~45 characters ever rendered — cutting it
      // off before "You can turn this off in Settings -> Updates.", the ONE actionable half of the
      // sentence. `title` is the floor: whatever does or does not fit on screen, the full text is
      // still reachable through a native tooltip (Finding 5, whole-branch review).
      title={current.message}
      onClick={() => noticeStore.dismiss(current.id)}
      // Widened well past the old cap for the same reason — this strip is `min-w-0` and the LAST
      // element in the case group (see TopBar.tsx), so it is the one thing that absorbs slack
      // rather than a fixed-width control anything else depends on; relaxing its cap costs no
      // other layout rule. Still `truncate` (single line): the header itself is a fixed `h-12`,
      // and wrapping a long notice across two lines risks overflowing that box in ways jsdom
      // cannot see — this widens the budget rather than removing it. NEEDS A HUMAN EYEBALL: jsdom
      // computes no layout, so neither the old cutoff nor this widened one can be verified here.
      className={`max-w-[32rem] truncate text-left text-xs ${
        current.tone === 'danger' ? 'text-danger' : 'text-dim'
      }`}
    >
      {current.message}
    </button>
  )
}
