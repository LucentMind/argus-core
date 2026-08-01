import { useSyncExternalStore } from 'react'
import { Sun, Moon, Settings, Gauge, Home } from 'lucide-react'
import { uiStore } from '../lib/uiStore'
import { caseBarStore, useCaseBar } from '../lib/caseBarStore'
import { CaseAnchor } from './CaseAnchor'
import { DistillChip } from './DistillChip'
import { HeaderChips } from './HeaderChips'
import { HeaderNotice } from './HeaderNotice'
import { JiraPill } from './JiraPill'
import { ModeSwitcher } from './ModeSwitcher'
import { DEFAULT_MODE } from '../../../shared/modes'
import type { CaseRecord } from '../../../shared/types'

const ACTION_BTN =
  'argus-nodrag inline-flex h-10 w-10 items-center justify-center rounded-r2 text-dim transition-colors hover:bg-hair hover:text-ink'

/**
 * The app's only chrome bar, and — inside a case — the case's chrome too.
 *
 * Grouped by *subject*, not by scope: `⌂ │ this case ‖ other cases │ the app`. The old split
 * (global strip above, case strip below) was a fact about the code, and it printed the case
 * id twice ~40px apart while putting the open-case tabs *between* the case id and the
 * controls that act on that case.
 *
 * The case group is not elastic and the strip is. That is the whole layout algorithm — no
 * ResizeObserver, no priority overflow list, no measurement pass. Two open cases or twenty,
 * the bar is identical.
 */
export function TopBar({
  activeSlug,
  activeCase,
  onHome,
  onSelect,
  onSettings,
  onStatusChanged,
  onObservability
}: {
  activeSlug: string | null
  /** The active case's record, or null while `cases` is still loading. `activeSlug` comes
   *  from the view and is the thing that decides whether the group renders at all, so the
   *  group does not blink out during a refetch. */
  activeCase: CaseRecord | null
  onHome: () => void
  onSelect: (slug: string) => void
  onSettings: () => void
  /** A case action changed status in the DB; the owner of the `cases` array must refetch. */
  onStatusChanged: () => void
  onObservability?: () => void
}): React.JSX.Element {
  const ui = useSyncExternalStore(
    (cb) => uiStore.subscribe(cb),
    () => uiStore.get()
  )
  const bar = useCaseBar()
  // Busy state is only this case's if it was published for this case: CaseWorkspace publishes
  // on a case switch too, and the bar re-renders before that publish lands.
  const busyForThisCase = activeSlug !== null && bar.slug === activeSlug

  return (
    // The OS window buttons live in their own strip above (TitleBarStrip), not beside this
    // header, so no inset is needed here — argus-drag stays because dragging by the header is
    // still good UX.
    <header className="argus-drag flex h-12 items-center gap-1.5 border-b border-hair bg-void px-3">
      {/* Wordmark and home control are one button, not two adjacent things: the brand belongs
          top-left on every view, and the top bar is the only chrome that renders on all of them —
          which is what lets home and Settings drop their local copies of the wordmark. */}
      <button
        className="argus-nodrag flex h-8 shrink-0 items-center gap-1.5 rounded-r2 border border-hair px-3 text-dim transition-colors hover:border-hair2 hover:bg-hair hover:text-ink"
        onClick={onHome}
        aria-label="All cases"
        title="All cases"
      >
        <span className="font-brand text-[13px] text-brand" style={{ letterSpacing: 5 }}>
          ARGUS
        </span>
        <Home size={16} strokeWidth={1.5} />
      </button>
      <div className="mx-1 h-6 w-px bg-hair" />
      {activeSlug !== null && (
        <>
          {/* One no-drag container for the whole group. Chromium subtracts a no-drag rect
              from the enclosing drag rect, so every control inside is reachable without
              threading a bar-specific class through six components that are not about
              the bar. */}
          <div
            data-testid="case-group"
            className="argus-nodrag flex h-8 shrink-0 items-center gap-2"
          >
            <CaseAnchor
              slug={activeSlug}
              status={activeCase?.status ?? 'open'}
              resolution={activeCase?.resolution ?? null}
              onStatusChanged={onStatusChanged}
              onHome={onHome}
            />
            {/* relative: the pill's popover is absolutely positioned and must anchor to the
                pill, not to the bar — key resets refresh state when switching cases */}
            <div className="relative shrink-0">
              <JiraPill
                key={activeSlug}
                slug={activeSlug}
                jiraKey={activeCase?.jiraKey ?? null}
                syncedAt={activeCase?.jiraSyncedAt ?? null}
              />
            </div>
            <ModeSwitcher
              slug={activeSlug}
              activeMode={activeCase?.activeMode ?? DEFAULT_MODE}
              // Review's PR search outlives cases.setMode and runs in CaseWorkspace, so the
              // only way the control knows to keep spinning is the store.
              busyMode={busyForThisCase ? bar.busyMode : null}
              statusText={busyForThisCase ? bar.statusText : null}
              onModeChanged={(mode, sessionId) =>
                caseBarStore.emit({ kind: 'mode-switched', slug: activeSlug, mode, sessionId })
              }
              onError={(message) =>
                caseBarStore.emit({ kind: 'mode-error', slug: activeSlug, message })
              }
            />
            <HeaderChips slug={activeSlug} />
            {/* Transient/informational content only, and deliberately last: everything left
                of here is fixed-width, so a landing notice or a distill event cannot shove a
                control the user is already reaching for. The elastic strip absorbs it. */}
            <div className="flex min-w-0 items-center gap-2">
              <DistillChip key={activeSlug} slug={activeSlug} />
              <HeaderNotice />
            </div>
          </div>
          <div className="mx-1 h-6 w-px bg-hair2" />
        </>
      )}
      <nav
        aria-label="Recent cases"
        className="tabstrip-fade argus-nodrag flex min-w-0 flex-1 items-center gap-1 overflow-x-auto"
      >
        {/* The active case is excluded: it lives in the anchor, and showing it in both places
            would restore the duplication this change exists to remove. Shift+wheel scrolls
            this natively — an overflow-x container needs no handler, and the nav opts out of
            the drag region that would otherwise swallow the event. */}
        {ui.recentTabs
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
      </nav>
      {onObservability && (
        <button
          className={ACTION_BTN}
          aria-label="Observability"
          title="Observability"
          onClick={onObservability}
        >
          <Gauge size={19} strokeWidth={1.5} />
        </button>
      )}
      <button className={ACTION_BTN} aria-label="Settings" title="Settings" onClick={onSettings}>
        <Settings size={19} strokeWidth={1.5} />
      </button>
      <button
        className={ACTION_BTN}
        aria-label={ui.theme === 'dark' ? 'Switch to light theme' : 'Switch to dark theme'}
        title={ui.theme === 'dark' ? 'Switch to light theme' : 'Switch to dark theme'}
        onClick={() => uiStore.toggleTheme()}
      >
        {ui.theme === 'dark' ? (
          <Sun size={19} strokeWidth={1.5} />
        ) : (
          <Moon size={19} strokeWidth={1.5} />
        )}
      </button>
    </header>
  )
}
