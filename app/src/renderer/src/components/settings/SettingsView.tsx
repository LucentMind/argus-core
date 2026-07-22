import { useState } from 'react'
import {
  Settings2,
  BrainCog,
  HeartPulse,
  Cable,
  Workflow,
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
import { SkillsSettings } from './SkillsSettings'
import { ProposalsPage } from './ProposalsPage'
import { ReferencesSettings } from './ReferencesSettings'
import { HivemindSettings } from './HivemindSettings'
import { ObservabilitySettings } from './ObservabilitySettings'
import { PacksSettings } from './PacksSettings'

const PAGES = [
  { id: 'general', label: 'General', enabled: true, Icon: Settings2 },
  { id: 'agent', label: 'Agent', enabled: true, Icon: BrainCog },
  { id: 'connectors', label: 'Connectors', enabled: true, Icon: Cable },
  { id: 'proposals', label: 'Proposals', enabled: true, Icon: Inbox },
  { id: 'skills', label: 'Skills', enabled: true, Icon: Workflow },
  { id: 'memory', label: 'Memory', enabled: true, Icon: HardDrive },
  { id: 'references', label: 'References', enabled: true, Icon: BookMarked },
  { id: 'hivemind', label: 'HiveMind', enabled: true, Icon: CloudSync },
  { id: 'packs', label: 'Packs', enabled: true, Icon: Package },
  { id: 'health', label: 'Health', enabled: true, Icon: HeartPulse },
  { id: 'observability', label: 'Observability', enabled: true, Icon: Gauge }
] as const satisfies ReadonlyArray<{
  id: string
  label: string
  enabled: boolean
  Icon: LucideIcon
}>
export type PageId = (typeof PAGES)[number]['id']

const ANCHOR: Partial<Record<PageId, string>> = {
  memory: 'settings-memory',
  skills: 'settings-skills',
  references: 'settings-references',
  hivemind: 'settings-hivemind',
  proposals: 'settings-proposals'
}

export function SettingsView({
  onClose,
  initialPage
}: {
  onClose: () => void
  initialPage?: PageId
}): React.JSX.Element {
  const [page, setPage] = useState<PageId>(
    initialPage && PAGES.some((p) => p.id === initialPage) ? initialPage : 'general'
  )
  const [proposalTypes, setProposalTypes] = useState<readonly ProposalType[] | undefined>(undefined)
  const payload = useSettingsPayload()
  const counts = useProposalCounts()

  useEscapeLayer({ onEscape: onClose })

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
        {PAGES.map((p) => (
          <button
            key={p.id}
            data-onboarding-anchor={ANCHOR[p.id]}
            disabled={!p.enabled}
            className={`flex items-center gap-2 rounded-r2 px-2.5 py-1.5 text-left text-xs transition-colors disabled:cursor-default ${
              page === p.id
                ? 'bg-hi text-ink'
                : p.enabled
                  ? 'text-dim hover:bg-hair hover:text-ink'
                  : 'text-faint'
            }`}
            onClick={() => {
              setProposalTypes(undefined)
              setPage(p.id)
            }}
          >
            <p.Icon size={15} strokeWidth={1.5} className="shrink-0" />
            <span className="flex-1">{p.label}</span>
            {p.id === 'proposals' && (counts?.pendingCount ?? 0) > 0 && (
              <span className="rounded-full bg-signal/15 px-1.5 font-mono text-[10px] text-signal">
                {counts!.pendingCount}
              </span>
            )}
            {!p.enabled && (
              <span className="font-mono text-[9px] uppercase tracking-wide text-faint">soon</span>
            )}
          </button>
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
          {payload && page === 'general' && <GeneralSettings payload={payload} />}
          {payload && page === 'agent' && <AgentSettings payload={payload} />}
          {page === 'health' && <HealthSettings />}
          {page === 'connectors' && <ConnectorsSettings />}
          {page === 'proposals' && <ProposalsPage initialTypes={proposalTypes} />}
          {page === 'skills' && <SkillsSettings onReviewProposals={openProposals} />}
          {payload && page === 'hivemind' && <HivemindSettings payload={payload} />}
          {payload && page === 'packs' && <PacksSettings settings={payload} />}
          {page === 'memory' && <MemorySettings onReviewProposals={openProposals} />}
          {page === 'references' && <ReferencesSettings onReviewProposals={openProposals} />}
          {payload && page === 'observability' && <ObservabilitySettings payload={payload} />}
        </div>
      </div>
    </div>
  )
}
