import { X } from 'lucide-react'
import { IconBtn } from '../ui'
import { settingsStore, useSettingsPayload } from '../../lib/settingsStore'

export type KnowledgeHubPage = 'sources' | 'library' | 'proposals' | 'team'

/**
 * Compact, dismissible "how knowledge flows" strip (spec §3.4), shown at the top
 * of the Library and Proposals pages. Each bold term navigates to its page.
 * Dismissal persists as settings.ui.knowledgeStripDismissed and never returns.
 */
export function KnowledgeFlowStrip({
  onNavigate
}: {
  onNavigate: (page: KnowledgeHubPage) => void
}): React.JSX.Element | null {
  const payload = useSettingsPayload()
  if (!payload || payload.settings.ui.knowledgeStripDismissed) return null

  const link = (page: KnowledgeHubPage, label: string): React.JSX.Element => (
    <button
      className="font-medium text-ink underline decoration-hair underline-offset-2 transition-colors hover:text-signal"
      onClick={() => onNavigate(page)}
    >
      {label}
    </button>
  )

  return (
    <div className="flex items-center gap-3 rounded-r2 border border-hair bg-deep px-3 py-2 text-xs text-dim">
      <span className="flex-1 leading-relaxed">
        {link('sources', 'Sources')} (packs · Confluence · your team&apos;s hive) →{' '}
        {link('library', 'Library')} (what the agent can use) → the agent distills sessions into{' '}
        {link('proposals', 'Proposals')} → you accept → {link('team', 'share back to the team')}.
      </span>
      <IconBtn
        aria-label="Dismiss knowledge flow strip"
        title="Dismiss"
        onClick={() => void settingsStore.patch({ ui: { knowledgeStripDismissed: true } })}
      >
        <X size={14} />
      </IconBtn>
    </div>
  )
}
