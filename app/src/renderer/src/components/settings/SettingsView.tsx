import { Fragment, useEffect, useState, useSyncExternalStore } from 'react'
import { visiblePages, type PageId } from './settingsPages'
import { useSettingsPayload } from '../../lib/settingsStore'
import { useProposalCounts } from '../../lib/proposalsStore'
import { useEscapeLayer } from '../../lib/escapeLayer'
import { settingsBarStore } from '../../lib/settingsBarStore'
import { uiStore } from '../../lib/uiStore'
import type { ProposalType } from '../../../../shared/proposals'
import { GeneralSettings } from './GeneralSettings'
import { AgentSettings } from './AgentSettings'
import { ConnectorsSettings } from './ConnectorsSettings'
import { HealthSettings } from './HealthSettings'
import { MemorySettings } from './MemorySettings'
import { ProposalsPage } from './ProposalsPage'
import { LibraryPage, type LibraryKind } from './LibraryPage'
import { SourcesPage } from './SourcesPage'
import { HivemindSettings } from './HivemindSettings'
import { ObservabilitySettings } from './ObservabilitySettings'
import { KnowledgeFlowStrip } from './KnowledgeFlowStrip'
import { PromptsDevPage } from './PromptsDevPage'
import { OverrideBanner } from './OverrideBanner'

// The nav table and its dev-gate filter live in `settingsPages.ts`; react-refresh requires a
// component file to export only components, so they cannot be shared from here.
export type { PageId }

/** Pre-hub page ids stay accepted as deep-link aliases (spec §3.3) — the
 *  onboarding wizard and stale runtime values route through them. */
const LEGACY_PAGES = {
  skills: { page: 'library', kind: 'skill' },
  references: { page: 'library', kind: 'reference' },
  hivemind: { page: 'team' },
  packs: { page: 'sources' }
} as const satisfies Record<string, { page: PageId; kind?: LibraryKind }>
export type LegacyPageId = keyof typeof LEGACY_PAGES
export type SettingsDeepLink = PageId | LegacyPageId

function resolveDeepLink(
  p: string | undefined,
  devTools: boolean
): { page: PageId; kind?: LibraryKind } {
  if (p && p in LEGACY_PAGES) return LEGACY_PAGES[p as LegacyPageId]
  // Filtered, not raw PAGES: a dev-only page must stay unreachable by a hand-typed link or a
  // stale runtime value when the gate is off — hiding it from the nav alone leaves that open.
  if (p && visiblePages(devTools).some((x) => x.id === p)) return { page: p as PageId }
  return { page: 'general' }
}

const ANCHOR: Partial<Record<PageId, string>> = {
  memory: 'settings-memory',
  library: 'settings-library',
  team: 'settings-team',
  proposals: 'settings-proposals'
}

export function SettingsView({
  onClose,
  initialPage
}: {
  onClose: () => void
  initialPage?: SettingsDeepLink
}): React.JSX.Element {
  // Read before the deep link resolves: the dev-tools gate decides which pages a link may
  // reach, so `payload` has to be in hand first.
  const payload = useSettingsPayload()
  const ui = useSyncExternalStore(
    (cb) => uiStore.subscribe(cb),
    () => uiStore.get()
  )
  const dynamic = ui.dynamicTheme
  const devTools = Boolean(payload?.devTools)
  const init = resolveDeepLink(initialPage, devTools)
  const [page, setPage] = useState<PageId>(init.page)
  const [proposalTypes, setProposalTypes] = useState<readonly ProposalType[] | undefined>(undefined)
  const [libraryKind, setLibraryKind] = useState<LibraryKind | undefined>(init.kind)
  const counts = useProposalCounts()
  const pages = visiblePages(devTools)
  // `pages`, not PAGES: an active page that the dev gate would hide must still fall back to
  // pages[0] rather than land on undefined (resolveDeepLink already keeps `page` inside
  // `pages`, but this stays defensive against the two agreeing on the filtered set).
  const active = pages.find((p) => p.id === page) ?? pages[0]

  // The header renders this now (spec §5.1). Two effects, not one: a single effect with a
  // cleanup would publish `null` on every page change before publishing the new page, blinking
  // the header's title on each navigation. This one tracks the page; the next clears on the way
  // out of Settings only.
  useEffect(() => {
    settingsBarStore.publish({ label: active.label, blurb: active.blurb })
  }, [active.label, active.blurb])
  useEffect(() => () => settingsBarStore.publish(null), [])

  useEscapeLayer({ onEscape: onClose })

  // App mounts this view without a key, so a deep link fired while Settings is
  // already open only changes `initialPage` — the state seeded above must follow
  // it (viewReducer's "switch pages instead of closing" contract). Adjust-state-
  // during-render, per react.dev's "you might not need an effect".
  const [lastDeepLink, setLastDeepLink] = useState(initialPage)
  if (initialPage !== lastDeepLink) {
    setLastDeepLink(initialPage)
    const next = resolveDeepLink(initialPage, devTools)
    setProposalTypes(undefined)
    setLibraryKind(next.kind)
    setPage(next.page)
  }

  /** All internal navigation funnels through here so page presets never leak across pages. */
  function goTo(p: PageId): void {
    setProposalTypes(undefined)
    setLibraryKind(undefined)
    setPage(p)
  }

  function openProposals(types: readonly ProposalType[]): void {
    setProposalTypes(types)
    setPage('proposals')
  }

  return (
    // The masthead that used to sit above this row is gone (spec
    // 2026-08-01-header-window-controls-design.md §4.3) — this row is the whole page now, so it
    // is the return value directly rather than the lone child of a `flex-col` wrapper that has
    // nothing else to stack it against. `DynamicScope`'s settings variant already supplies the
    // `flex-col` ancestor this needs to fill.
    <div className="flex min-h-0 flex-1">
      <nav
        aria-label="Settings sections"
        className={`flex w-48 shrink-0 flex-col gap-0.5 border-r border-hair p-3 ${dynamic ? 'dyn-rail' : 'bg-void'}`}
      >
        {/* `pages`, not PAGES — the group-header lookup must read the same filtered array, or
              hiding the last page in a group leaves its heading behind with nothing under it. */}
        {pages.map((p, i) => (
          <Fragment key={p.id}>
            {(i === 0 || pages[i - 1].group !== p.group) && (
              // text-mute, not text-faint (user-directed, 2026-08-02): --faint is white @18% in
              // dark and navy @30% in light, and at 9px these headings were unreadable in BOTH —
              // washed out against the rail in light, nearly gone in dark. --mute (38%/50%) is the
              // next rung and fixes both directions at once; it is still a rung below the
              // --dim/--ink the nav items themselves use, so the heading↔item hierarchy holds.
              <div
                className={`px-2.5 pb-1 font-mono text-[9px] uppercase tracking-wide text-mute ${
                  i === 0 ? 'pt-1' : 'pt-3'
                }`}
              >
                {p.group}
              </div>
            )}
            <button
              data-onboarding-anchor={ANCHOR[p.id]}
              disabled={!p.enabled}
              className={`flex items-center gap-2 rounded-r2 px-2.5 py-1.5 text-left text-xs transition-colors disabled:cursor-default ${
                page === p.id
                  ? 'bg-hi text-ink'
                  : p.enabled
                    ? 'text-dim hover:bg-hair hover:text-ink'
                    : 'text-faint'
              }`}
              onClick={() => goTo(p.id)}
            >
              <p.Icon size={15} strokeWidth={1.5} className="shrink-0" />
              <span className="flex-1">{p.label}</span>
              {p.id === 'proposals' && (counts?.pendingCount ?? 0) > 0 && (
                <span
                  aria-hidden="true"
                  className="rounded-full bg-signal/15 px-1.5 font-mono text-[10px] text-signal"
                >
                  {counts!.pendingCount}
                </span>
              )}
              {!p.enabled && (
                <span className="font-mono text-[9px] uppercase tracking-wide text-faint">
                  soon
                </span>
              )}
            </button>
          </Fragment>
        ))}
      </nav>
      {/* scrollbar-gutter: content that grows past the fold (opening a memory editor, expanding
            a provider) must not shove every control left by the scrollbar's width. Reserving the
            gutter keeps the page width constant whether or not the bar is showing. */}
      <div className="min-w-0 flex-1 overflow-y-auto [scrollbar-gutter:stable]">
        <div className="mx-auto flex w-full max-w-6xl flex-col gap-6 p-8">
          {payload?.loadError && (
            <div
              role="alert"
              className="flex items-center gap-3 rounded-r2 border border-danger/40 bg-danger/10 px-3 py-2 text-xs text-danger"
            >
              <span className="flex-1">
                {payload.loadError.startsWith('settings save failed')
                  ? payload.loadError
                  : `settings.json could not be parsed — using defaults. (${payload.loadError})`}
              </span>
              <button
                className="underline transition-colors hover:text-ink"
                onClick={() => void window.argus.settings.reveal('settingsFile')}
              >
                Open file
              </button>
            </div>
          )}
          <OverrideBanner devTools={devTools} />
          {(page === 'library' || page === 'proposals') && <KnowledgeFlowStrip onNavigate={goTo} />}
          {payload && page === 'general' && <GeneralSettings payload={payload} />}
          {payload && page === 'agent' && <AgentSettings payload={payload} />}
          {page === 'health' && <HealthSettings />}
          {page === 'connectors' && <ConnectorsSettings />}
          {page === 'proposals' && (
            <ProposalsPage
              // Remount on preset change (see Tier-1 rationale): wipes transient state deliberately.
              key={proposalTypes?.join(',') ?? 'all'}
              initialTypes={proposalTypes}
              onOpenHivemind={() => goTo('team')}
            />
          )}
          {page === 'library' && (
            <LibraryPage
              // Same remount idiom as ProposalsPage: an alias/banner preset forces a fresh page.
              key={libraryKind ?? 'all'}
              initialKind={libraryKind}
              onReviewProposals={openProposals}
            />
          )}
          {payload && page === 'team' && <HivemindSettings payload={payload} />}
          {payload && page === 'sources' && <SourcesPage settings={payload} />}
          {page === 'memory' && <MemorySettings onReviewProposals={openProposals} />}
          {payload && page === 'observability' && <ObservabilitySettings payload={payload} />}
          {page === 'prompts' && <PromptsDevPage />}
        </div>
      </div>
    </div>
  )
}
