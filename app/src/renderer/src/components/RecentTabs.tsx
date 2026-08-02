import { useSyncExternalStore } from 'react'
import { uiStore } from '../lib/uiStore'

/**
 * The recently-opened cases: the tab band inside TopBar's right group, which is what bounds it
 * — the group is capped at half the bar and the action icons inside it never shrink, so this
 * band gets exactly "whatever is left between the bar's mid-point and the icons" and the icons
 * are visible at every window width (user-directed, 2026-08-02).
 *
 * This component therefore owns no margin of its own. An earlier version placed the band with
 * `ml-[50%]`, which is the bug that made the icons leave the window: a percentage margin is not
 * flexible, so when the case group plus that margin exceeded the bar the overflow had nowhere
 * to go and pushed everything after it off the right edge. Bounding is the parent's job; this
 * one only has to shrink to nothing (`min-w-0`) when asked.
 *
 * The right-alignment is an `ml-auto` on the inner row, NOT `justify-end` on the scroller. An
 * auto margin collapses to zero once the content overflows, so the list simply starts scrolling
 * from its left edge; `justify-end` instead keeps pushing, and the overflow spills past the
 * container's start edge where scrolling cannot reach it. Shift+wheel scrolls it natively — an
 * `overflow-x` container needs no handler.
 *
 * The active case is deliberately absent: it lives in the bar's case anchor, and showing it in
 * both places is the duplication this layout exists to remove.
 *
 * `argus-nodrag` is what makes any of it clickable — and scrollable: the OS drag handler
 * swallows the wheel gesture over a drag region too.
 */
export function RecentTabs({
  activeSlug,
  onSelect
}: {
  activeSlug: string | null
  onSelect: (slug: string) => void
}): React.JSX.Element {
  const recentTabs = useSyncExternalStore(
    (cb) => uiStore.subscribe(cb),
    () => uiStore.get()
  ).recentTabs

  return (
    <nav
      aria-label="Recent cases"
      className="tabstrip-fade argus-nodrag flex h-full min-w-0 flex-1 items-center overflow-x-auto"
    >
      <div className="ml-auto flex shrink-0 items-center gap-1">
        {recentTabs
          .filter((slug) => slug !== activeSlug)
          .map((slug, i) => (
            <span
              key={slug}
              className="group relative flex shrink-0 items-center rounded-r2 border border-transparent text-sm text-dim transition-colors hover:bg-hair hover:text-ink"
            >
              {i > 0 && (
                <span
                  data-tab-separator
                  aria-hidden="true"
                  className="pointer-events-none absolute -left-0.5 h-4 w-px bg-hair"
                />
              )}
              <button className="argus-nodrag py-1.5 pl-3 font-mono" onClick={() => onSelect(slug)}>
                {slug}
              </button>
              <button
                aria-label={`Close ${slug}`}
                className="argus-nodrag px-2 py-1.5 text-base leading-none text-mute opacity-0 transition-[color,opacity] hover:text-danger focus-visible:opacity-100 group-hover:opacity-100"
                onClick={() => uiStore.closeTab(slug)}
              >
                ×
              </button>
            </span>
          ))}
      </div>
    </nav>
  )
}
