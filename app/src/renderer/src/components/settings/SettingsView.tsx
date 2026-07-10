import { useEffect, useState } from 'react'
import { useSettingsPayload } from '../../lib/settingsStore'
import { GeneralSettings } from './GeneralSettings'
import { AgentSettings } from './AgentSettings'
import { ToolsSettings } from './ToolsSettings'
import { ConnectorsSettings } from './ConnectorsSettings'

const PAGES = [
  { id: 'general', label: 'General', enabled: true },
  { id: 'agent', label: 'Agent', enabled: true },
  { id: 'tools', label: 'Analysis Tools', enabled: true },
  { id: 'health', label: 'Health', enabled: false },
  { id: 'connectors', label: 'Connectors', enabled: true },
  { id: 'skills', label: 'Skills', enabled: false },
  { id: 'memory', label: 'Memory', enabled: false },
  { id: 'observability', label: 'Observability', enabled: false }
] as const
type PageId = (typeof PAGES)[number]['id']

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
            disabled={!p.enabled}
            className={`flex items-center justify-between rounded-r2 px-2.5 py-1.5 text-left text-xs transition-colors disabled:cursor-default ${
              page === p.id
                ? 'bg-hi text-ink'
                : p.enabled
                  ? 'text-dim hover:bg-hair hover:text-ink'
                  : 'text-faint'
            }`}
            onClick={() => setPage(p.id)}
          >
            <span>{p.label}</span>
            {!p.enabled && (
              <span className="font-mono text-[9px] uppercase tracking-wide text-faint">soon</span>
            )}
          </button>
        ))}
      </nav>
      <div className="min-w-0 flex-1 overflow-y-auto">
        <div className="mx-auto flex w-full max-w-2xl flex-col gap-6 p-8">
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
          {page === 'connectors' && <ConnectorsSettings />}
        </div>
      </div>
    </div>
  )
}
