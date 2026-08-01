import { Fragment, useState, useSyncExternalStore } from 'react'
import { visiblePages, type PageId } from './settingsPages'
import { useSettingsPayload } from '../../lib/settingsStore'
import { useProposalCounts } from '../../lib/proposalsStore'
import { useEscapeLayer } from '../../lib/escapeLayer'
import { useAmbientAnchors } from '../../lib/ambientAnchors'
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
  const anchors = useAmbientAnchors()
  // `pages`, not PAGES: an active page that the dev gate would hide must still fall back to
  // pages[0] rather than land on undefined (resolveDeepLink already keeps `page` inside
  // `pages`, but this stays defensive against the two agreeing on the filtered set).
  const active = pages.find((p) => p.id === page) ?? pages[0]

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
    <div className="flex min-h-0 flex-1 flex-col pt-6">
      {/* anchors.setCutoff/setLight are useState setters used directly as ref callbacks (the
          React-documented way to observe a DOM node) — not a stale `.current` read, so
          react-hooks/refs is a false positive here. */}
      {/* eslint-disable-next-line react-hooks/refs */}
      <div ref={anchors.setCutoff} className="flex shrink-0 items-end border-b border-hair pb-3.5">
        {/* Spacer, not a container. The wordmark moved into the top bar's home button — one brand
            mark per window — but this column's width is still load-bearing: it is what holds the
            title on the same x as the content column beside the nav rail. */}
        <div className="w-48 shrink-0" aria-hidden="true" />
        {/* Masthead stays full width (unlike home, this is the one deliberately-unconditional
            layout exception — see CLAUDE.md) so the ambient ribbon still lights the nav rail's
            top edge. But the title/blurb themselves live in their own `mx-auto max-w-6xl`
            column, mirroring the content column below (`min-w-0 flex-1 overflow-y-auto` >
            `mx-auto max-w-6xl p-8`) exactly the way CaseDashboard keeps its wordmark inside the
            same centred column as its cards. Below ~1344px (192px rail + 1152px max-w-6xl) this
            renders identically to the old flex-1 span; above it, the title now tracks the
            content instead of drifting toward the rail as the window widens — which also keeps
            the ambient light (anchored to the h1 below) over the cards it is meant to land on,
            not the empty gutter beside them. */}
        <div className="min-w-0 flex-1">
          <div className="mx-auto flex w-full max-w-6xl flex-col gap-0.5 px-8">
            <h1
              // eslint-disable-next-line react-hooks/refs
              ref={anchors.setLight}
              data-testid="settings-title"
              className="truncate text-[23px] font-light text-ink"
            >
              {active.label}
            </h1>
            {/* Single line, always: several blurbs wrap at narrow widths, and a masthead that
                grows by a line on navigation shoves the whole content column down. `title`
                keeps the full text reachable when it is clipped. */}
            <p
              data-testid="settings-blurb"
              title={active.blurb}
              className="truncate text-xs text-dim"
            >
              {active.blurb}
            </p>
          </div>
        </div>
      </div>
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
                <div
                  className={`px-2.5 pb-1 font-mono text-[9px] uppercase tracking-wide text-faint ${
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
            {(page === 'library' || page === 'proposals') && (
              <KnowledgeFlowStrip onNavigate={goTo} />
            )}
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
    </div>
  )
}
