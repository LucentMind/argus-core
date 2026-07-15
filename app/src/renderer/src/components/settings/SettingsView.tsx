import { useEffect, useState } from 'react'
import {
  Settings2,
  BrainCog,
  Logs,
  HeartPulse,
  Cable,
  Workflow,
  CloudSync,
  HardDrive,
  BookMarked,
  Gauge,
  Package,
  type LucideIcon
} from 'lucide-react'
import { useSettingsPayload } from '../../lib/settingsStore'
import { GeneralSettings } from './GeneralSettings'
import { AgentSettings } from './AgentSettings'
import { ToolsSettings } from './ToolsSettings'
import { ConnectorsSettings } from './ConnectorsSettings'
import { HealthSettings } from './HealthSettings'
import { MemorySettings } from './MemorySettings'
import { SkillsSettings } from './SkillsSettings'
import { ReferencesSettings } from './ReferencesSettings'
import { HivemindSettings } from './HivemindSettings'
import { ObservabilitySettings } from './ObservabilitySettings'
import { PacksSettings } from './PacksSettings'

const PAGES = [
  { id: 'general', label: 'General', enabled: true, Icon: Settings2 },
  { id: 'agent', label: 'Agent', enabled: true, Icon: BrainCog },
  { id: 'tools', label: 'Analysis Tools', enabled: true, Icon: Logs },
  { id: 'health', label: 'Health', enabled: true, Icon: HeartPulse },
  { id: 'connectors', label: 'Connectors', enabled: true, Icon: Cable },
  { id: 'skills', label: 'Skills', enabled: true, Icon: Workflow },
  { id: 'hivemind', label: 'HiveMind', enabled: true, Icon: CloudSync },
  { id: 'packs', label: 'Packs', enabled: true, Icon: Package },
  { id: 'memory', label: 'Memory', enabled: true, Icon: HardDrive },
  { id: 'references', label: 'References', enabled: true, Icon: BookMarked },
  { id: 'observability', label: 'Observability', enabled: true, Icon: Gauge }
] as const satisfies ReadonlyArray<{
  id: string
  label: string
  enabled: boolean
  Icon: LucideIcon
}>
type PageId = (typeof PAGES)[number]['id']

const ANCHOR: Partial<Record<PageId, string>> = {
  memory: 'settings-memory',
  skills: 'settings-skills',
  references: 'settings-references',
  hivemind: 'settings-hivemind'
}

export function SettingsView({ onClose }: { onClose: () => void }): React.JSX.Element {
  const [page, setPage] = useState<PageId>('general')
  const payload = useSettingsPayload()

  useEffect(() => {
    const onKey = (e: KeyboardEvent): void => {
      if (e.key !== 'Escape') return
      const tag = (e.target as HTMLElement | null)?.tagName
      if (tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT') return
      onClose()
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [onClose])

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
            onClick={() => setPage(p.id)}
          >
            <p.Icon size={15} strokeWidth={1.5} className="shrink-0" />
            <span className="flex-1">{p.label}</span>
            {!p.enabled && (
              <span className="font-mono text-[9px] uppercase tracking-wide text-faint">soon</span>
            )}
          </button>
        ))}
      </nav>
      <div className="min-w-0 flex-1 overflow-y-auto">
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
          {payload && page === 'tools' && <ToolsSettings payload={payload} />}
          {page === 'health' && <HealthSettings />}
          {page === 'connectors' && <ConnectorsSettings />}
          {page === 'skills' && <SkillsSettings />}
          {payload && page === 'hivemind' && <HivemindSettings payload={payload} />}
          {page === 'packs' && <PacksSettings />}
          {page === 'memory' && <MemorySettings />}
          {page === 'references' && <ReferencesSettings />}
          {payload && page === 'observability' && <ObservabilitySettings payload={payload} />}
        </div>
      </div>
    </div>
  )
}
