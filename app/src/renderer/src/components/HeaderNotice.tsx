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
      // A wider SINGLE line was tried first (`max-w-[32rem]`, replacing the original `max-w-80`)
      // and measured live to still be wrong: the mandated first-run string is ~132 characters and
      // renders ~714px wide at this font, so even 512px truncated it — right after "You", before
      // "can turn this off in Settings -> Updates.", the one actionable half. A wider cap only
      // moves that same failure to a longer string; it does not fix the class of bug.
      // `line-clamp-2` (existing idiom — see settingsLayout.tsx, CaseCard.tsx) wraps onto a second
      // line instead of chasing a wider first one. `whitespace-normal` is explicit rather than
      // relied-upon-by-default (same belt-and-braces pairing as CaseFiles.tsx's badge), and
      // `max-w-[32rem]` is kept as the WRAP width, not a truncation budget — at that width the
      // mandated first-run string fits fully across two lines with room to spare (measured live
      // over CDP: see task-9-live-report.md's "Check 7 fix" section), so the clamp is a ceiling
      // against some future even-longer notice, not something this string actually touches.
      className={`line-clamp-2 max-w-[32rem] whitespace-normal text-left text-xs ${
        current.tone === 'danger' ? 'text-danger' : 'text-dim'
      }`}
    >
      {current.message}
    </button>
  )
}
