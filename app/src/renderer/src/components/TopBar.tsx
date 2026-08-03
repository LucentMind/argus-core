import { useSyncExternalStore } from 'react'
import { Sun, Moon, Settings, Gauge, Home } from 'lucide-react'
import { useAmbientAnchors } from '../lib/ambientAnchors'
import { uiStore } from '../lib/uiStore'
import { caseBarStore, useCaseBar } from '../lib/caseBarStore'
import { useSettingsBar } from '../lib/settingsBarStore'
import { isDarwin } from '../lib/platform'
import { WindowControls } from './WindowControls'
import { CaseAnchor } from './CaseAnchor'
import { DistillChip } from './DistillChip'
import { HeaderChips } from './HeaderChips'
import { HeaderNotice } from './HeaderNotice'
import { ModeSwitcher } from './ModeSwitcher'
import { RecentTabs } from './RecentTabs'
import { railTier } from '../lib/priorityRail'
import { DEFAULT_MODE } from '../../../shared/modes'
import type { CaseRecord } from '../../../shared/types'

const ACTION_BTN =
  'argus-nodrag inline-flex h-10 w-10 shrink-0 items-center justify-center rounded-r2 text-dim transition-colors hover:bg-hair hover:text-ink'

/**
 * The app's only chrome bar, and — inside a case — the case's chrome too.
 *
 * Grouped by *subject*, not by scope: `⌂ │ this case ‖ other cases │ the app`. The old split
 * (global strip above, case strip below) was a fact about the code, and it printed the case
 * id twice ~40px apart while putting the open-case tabs *between* the case id and the
 * controls that act on that case.
 *
 * The case group is not elastic and the tab band is — and the band cannot start left of the
 * bar's mid-point, so the case group's half is untouchable whatever the case list does. That
 * is the whole layout algorithm — no ResizeObserver, no priority overflow list, no measurement
 * pass. Two open cases or twenty, the left half of the bar is identical.
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
  const anchors = useAmbientAnchors()
  // Non-null exactly while Settings is up — SettingsView publishes its active page here because
  // this bar is its SIBLING, not its ancestor. Doubles as the "am I in Settings" flag the
  // anchor below keys off, so there is one source of truth for it.
  const settingsBar = useSettingsBar()
  // Busy state is only this case's if it was published for this case: CaseWorkspace publishes
  // on a case switch too, and the bar re-renders before that publish lands.
  const busyForThisCase = activeSlug !== null && bar.slug === activeSlug
  const controls = !isDarwin()

  return (
    // This header IS the title bar now — there is no strip above it, and the window's caption
    // buttons live at its right end.
    <header
      // In Settings the band dies at this header's own bottom edge; on every other view the view
      // owns this anchor (home's filter row, the case view's band), which is why the ref is
      // conditional: the header outlives each view, so an unconditional one would keep the band
      // pinned here after Settings closes. `setLight`/`setCutoff` are the claim/release ref
      // callbacks from lib/ambientAnchors.ts, not bare `useState` setters: each returns a cleanup
      // that clears the slot only if it still holds the node THAT callback attached, so this
      // header's detach on leaving Settings cannot null out an anchor the incoming view already
      // claimed. Still a ref callback underneath, so react-hooks/refs is a false positive.
      // eslint-disable-next-line react-hooks/refs
      ref={settingsBar ? anchors.setCutoff : null}
      className={`argus-drag argus-header-inset relative z-20 flex h-12 items-center gap-1.5 ${
        // Transparent so the flow reads through it. With the dynamic theme off there is no
        // canvas, and the bar keeps its own ground and hairline.
        //
        // z-20, not z-10: `relative` makes this a stacking context, which clamps every popover
        // inside it (CaseAnchor's menu, `absolute z-30`) to this layer regardless of its own
        // z-index. UpdateBanner sits right below the header in DOM order and is `relative z-10`
        // for the same above-the-canvas reason, so at equal z-index the banner would win the
        // paint-order tie and roof over any header popover opening down into its band. The header
        // has to out-rank the BANNER, not just the canvas — z-10 satisfies the canvas alone and
        // still loses here.
        ui.dynamicTheme ? '' : 'border-b border-hair bg-void'
      } ${controls ? 'pr-0' : 'pr-3'}`}
    >
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
      {/* Settings' page identity, where the case group sits in a case. The two are mutually
          exclusive by construction: Settings is not a case view, so `activeSlug` is null whenever
          this is non-null. `min-w-0` with no grow factor — sized by its content, free to shrink
          and truncate when the tab band needs the width. */}
      {settingsBar && (
        // Absolutely positioned, and OUT of the flex row on purpose (user-directed, 2026-08-02):
        // the title has to line up with the settings content column below, and that column's left
        // edge is a fact about SettingsView's layout (`w-48` rail + the page's `p-8`), not about
        // anything in this bar. `pl-56` = 12rem + 2rem = exactly that edge. Left in flow it would
        // instead start wherever the wordmark button happens to end, and — worse — a long page
        // label would push the tab band and the action icons rightward, which is the failure the
        // right group's width budget exists to prevent.
        //
        // The offset itself is `.argus-settings-masthead` in main.css, NOT a `left-*`/`pl-*`
        // utility, purely so a fixed `14rem` has one named place to live rather than being an
        // arbitrary Tailwind value repeated at the call site. It is a plain `left: 14rem` — the
        // header's own `.argus-header-inset` padding does NOT need cancelling here, because an
        // absolutely positioned box's `left` is measured from its containing block's padding-BOX
        // EDGE, which sits at the header's own outer edge regardless of the header's padding-left
        // (confirmed empirically; see that rule's comment for the measurement).
        //
        // 14rem clears the wordmark button (~124px) even at the darwin inset's 78px floor
        // (78 + 124 = 202 < 224), so the two cannot collide. The one place the
        // alignment loosens is a window wide enough for the content pane to exceed `max-w-6xl`
        // (~1350px+), where `mx-auto` starts centring the column away from the rail; the title
        // stays put. Tracking that exactly would mean measuring a sibling view's DOM from here.
        <div className="argus-settings-masthead pointer-events-none absolute inset-y-0 flex items-center">
          {/* Blurb text survives as the tooltip — every page still has one (see
              SettingsMasthead.test) and it is the only place the longer description is reachable
              now that the second line is gone. `pointer-events-auto` is what lets it be hovered
              at all, the wrapper above having turned them off so this overlay cannot eat clicks
              aimed at the drag region behind it. */}
          <span
            // eslint-disable-next-line react-hooks/refs
            ref={anchors.setLight}
            data-testid="settings-title"
            title={settingsBar.blurb}
            className="pointer-events-auto truncate text-base leading-tight text-ink"
          >
            {settingsBar.label}
          </span>
        </div>
      )}
      {activeSlug !== null && (
        <>
          {/* Separates the wordmark from the case group. It used to sit outside this branch and
              render on every view — which left a hairline hanging in open space on home and in
              Settings, dividing the wordmark from nothing (user-directed, 2026-08-02). A divider
              only means anything with content on both sides of it, and only the case view has
              that: Settings' title is absolutely positioned and out of this flow entirely. */}
          <div className="mx-1 h-6 w-px bg-hair" />
          {/* One no-drag container for the whole group. Chromium subtracts a no-drag rect
              from the enclosing drag rect, so every control inside is reachable without
              threading a bar-specific class through six components that are not about
              the bar. */}
          <div className="argus-nodrag flex h-full shrink-0 items-center">
            {/* This inner box is the drag-safe rect itself, i.e. what `argus-nodrag` above
                subtracts from the header's drag rect: `-webkit-app-region` is not inherited,
                Chromium builds no-drag regions from each styled element's own border-box, so a
                `h-8` no-drag rect vertically centred in a `h-12` drag header leaves a strip
                above and below it still draggable — which CaseAnchor's menu (`absolute`, opening
                a couple px below this box, as the Jira popover that also lived here used to) would
                open into.
                The outer div above stands in for that instead, spanning the full header height. */}
            <div
              data-testid="case-group"
              data-tier={
                ui.dynamicTheme
                  ? (railTier(activeCase?.jiraPriority ?? null) ?? undefined)
                  : undefined
              }
              className={`flex h-8 shrink-0 items-center gap-2 ${
                // TopBar renders outside DynamicScope, so the group carries its own scope.
                // `.dyn` is a plain class that re-declares the raw token vars and `theme.css`
                // maps every Tailwind colour through them — so it nests, and this restyles the
                // group without moving the bar into the scope tree.
                ui.dynamicTheme ? 'dyn dyn-case dyn-case-bar px-2' : ''
              }`}
            >
              <CaseAnchor
                key={activeSlug}
                slug={activeSlug}
                status={activeCase?.status ?? 'open'}
                resolution={activeCase?.resolution ?? null}
                onStatusChanged={onStatusChanged}
                onHome={onHome}
              />
              {/* No Jira pill here any more (user-directed, 2026-08-02): the bar was crowded,
                  and of everything in the group the pill was the one thing that is a *source*
                  rather than a control over the case — so it went down to the evidence rail with
                  the case's other sources (see CaseWorkspace). */}
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
          </div>
          <div className="mx-1 h-6 w-px bg-hair2" />
        </>
      )}
      {/* The right group, and the whole of the bar's layout rule.

          `max-w-[50%]` is the "from the centre" half: the group can never start left of the
          bar's mid-point, so a long case list cannot reach across into the case group's
          territory. `ml-auto` is what keeps it flush right once it stops growing (a capped
          flex item leaves free space unclaimed; an auto margin absorbs it). `min-w-0` is the
          "icons are always visible" half: the group may shrink below its content, and since
          the three buttons inside it are `shrink-0` and the tab band is `min-w-0`, the band is
          what gives — down to nothing — while the icons keep their width.

          What NOT to do here, because it was tried: putting the 50% on the tab band itself as
          `ml-[50%]`. A percentage margin is not flexible, so once the case group plus that
          margin exceeded the bar the excess had nowhere to go and shoved the action icons off
          the right edge of the window.

          All of that is about BOUNDING the band, so it applies only when there is a band. Without
          one the growth rules are actively wrong: `flex-1` still stretched the group to half the
          bar, and since the icons inside are `shrink-0` and nothing right-aligns them within it,
          they sat at the group's leading edge — stranded mid-bar, which is what shipped when the
          band became case-only. Content-sized plus `ml-auto` is what keeps them in the corner. */}
      <div
        className={`ml-auto flex items-center gap-1.5 ${
          activeSlug !== null ? 'min-w-0 max-w-[50%] flex-1' : ''
        }`}
      >
        {/* Tabs are a CASE-view control (user-directed, 2026-08-02): on home the grid below is
            already the full case list, and in Settings there is no case in view for them to
            switch between — in both, the band was showing a second, lesser copy of navigation
            the view itself owns. `activeSlug` is null on exactly those two views, so the same
            flag that hides the case group is the one that hides the band.
            The tabs themselves are NOT forgotten while hidden: `uiStore.recentTabs` outlives
            this, so reopening any case brings the whole band back as it was. */}
        {activeSlug !== null && <RecentTabs activeSlug={activeSlug} onSelect={onSelect} />}
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
      </div>
      {/* Outside the `max-w-[50%]` group on purpose: the window's caption buttons are not part of
          the bar's width budget, and they must stay flush in the corner however the tab band and
          the action icons negotiate the space to their left. */}
      <WindowControls />
    </header>
  )
}
