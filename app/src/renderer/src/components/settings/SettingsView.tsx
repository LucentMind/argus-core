import { Fragment, useState } from 'react'
import {
  Settings2,
  BrainCog,
  HeartPulse,
  Cable,
  CloudSync,
  HardDrive,
  BookMarked,
  Gauge,
  Package,
  Inbox,
  type LucideIcon
} from 'lucide-react'
import { useSettingsPayload } from '../../lib/settingsStore'
import { useProposalCounts } from '../../lib/proposalsStore'
import { useEscapeLayer } from '../../lib/escapeLayer'
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

/** Sidebar pages in three labeled groups (spec §3.1): App / Knowledge / System. */
const PAGES = [
  { id: 'general', label: 'General', group: 'App', enabled: true, Icon: Settings2 },
  { id: 'agent', label: 'Agent', group: 'App', enabled: true, Icon: BrainCog },
  { id: 'connectors', label: 'Connectors', group: 'App', enabled: true, Icon: Cable },
  { id: 'proposals', label: 'Proposals', group: 'Knowledge', enabled: true, Icon: Inbox },
  { id: 'library', label: 'Library', group: 'Knowledge', enabled: true, Icon: BookMarked },
  { id: 'memory', label: 'Memory', group: 'Knowledge', enabled: true, Icon: HardDrive },
  { id: 'team', label: 'Team', group: 'Knowledge', enabled: true, Icon: CloudSync },
  { id: 'sources', label: 'Sources', group: 'Knowledge', enabled: true, Icon: Package },
  { id: 'health', label: 'Health', group: 'System', enabled: true, Icon: HeartPulse },
  { id: 'observability', label: 'Observability', group: 'System', enabled: true, Icon: Gauge }
] as const satisfies ReadonlyArray<{
  id: string
  label: string
  group: 'App' | 'Knowledge' | 'System'
  enabled: boolean
  Icon: LucideIcon
}>
export type PageId = (typeof PAGES)[number]['id']

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

function resolveDeepLink(p?: string): { page: PageId; kind?: LibraryKind } {
  if (p && p in LEGACY_PAGES) return LEGACY_PAGES[p as LegacyPageId]
  if (p && PAGES.some((x) => x.id === p)) return { page: p as PageId }
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
  const init = resolveDeepLink(initialPage)
  const [page, setPage] = useState<PageId>(init.page)
  const [proposalTypes, setProposalTypes] = useState<readonly ProposalType[] | undefined>(undefined)
  const [libraryKind, setLibraryKind] = useState<LibraryKind | undefined>(init.kind)
  const payload = useSettingsPayload()
  const counts = useProposalCounts()

  useEscapeLayer({ onEscape: onClose })

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
    <div className="flex min-h-0 flex-1">
      <nav
        aria-label="Settings sections"
        className="flex w-48 shrink-0 flex-col gap-0.5 border-r border-hair bg-deep p-3"
      >
        {PAGES.map((p, i) => (
          <Fragment key={p.id}>
            {(i === 0 || PAGES[i - 1].group !== p.group) && (
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
        </div>
      </div>
    </div>
  )
}
