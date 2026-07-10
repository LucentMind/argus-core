import { useEffect, useState } from 'react'
import { InstalledSkills } from './InstalledSkills'
import { HivemindTab } from './HivemindTab'
import { ProposalsTab } from './ProposalsTab'

const TABS = [
  { id: 'installed', label: 'Installed' },
  { id: 'hivemind', label: 'HiveMind' },
  { id: 'proposals', label: 'Proposals' }
] as const
type SkillsTab = (typeof TABS)[number]['id']

export function SkillsSettings(): React.JSX.Element {
  const [tab, setTab] = useState<SkillsTab>('installed')
  const [pending, setPending] = useState(0)
  useEffect(() => {
    let mounted = true
    void window.argus.proposals
      .list()
      .then((p) => {
        if (mounted) setPending(p.proposals.length)
      })
      .catch(() => undefined)
    return () => {
      mounted = false
    }
  }, [])

  return (
    <div className="flex flex-col gap-4">
      <div role="tablist" className="flex items-center gap-1 border-b border-hair">
        {TABS.map((t) => (
          <button
            key={t.id}
            role="tab"
            aria-selected={tab === t.id}
            className={`-mb-px border-b px-3 py-1.5 text-sm transition-colors ${
              tab === t.id ? 'border-signal text-ink' : 'border-transparent text-dim hover:text-ink'
            }`}
            onClick={() => setTab(t.id)}
          >
            {t.label}
            {t.id === 'proposals' && pending > 0 ? ` (${pending})` : ''}
          </button>
        ))}
      </div>
      {tab === 'installed' && <InstalledSkills />}
      {tab === 'hivemind' && <HivemindTab />}
      {tab === 'proposals' && <ProposalsTab onCountChange={setPending} />}
    </div>
  )
}
