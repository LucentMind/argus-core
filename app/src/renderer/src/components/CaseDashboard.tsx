import type { CaseRecord, CaseStatus } from '../../../shared/types'
import { Card, Chip, SectionLabel } from './ui'

const STATUS_TONE: Record<CaseStatus, 'signal' | 'defect' | 'review' | 'neutral'> = {
  open: 'signal',
  analyzing: 'defect',
  'rca-drafted': 'review',
  closed: 'neutral'
}

export function CaseDashboard({
  cases,
  onOpen,
  onNew
}: {
  cases: CaseRecord[]
  onOpen: (slug: string) => void
  onNew: () => void
}): React.JSX.Element {
  return (
    <div className="mx-auto flex w-full max-w-5xl flex-col gap-6 p-8">
      <div className="flex flex-col gap-1">
        <SectionLabel>Cases · {cases.length} total</SectionLabel>
        <h1 className="text-2xl font-semibold tracking-tight text-ink">Argus</h1>
        <p className="text-sm text-dim">Defect analysis workbench</p>
      </div>
      <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-3">
        {cases.map((c) => (
          <Card key={c.slug} onClick={() => onOpen(c.slug)} className="flex flex-col gap-2 p-4">
            <div className="flex items-center justify-between">
              <span className="font-mono text-sm text-defect">{c.slug}</span>
              <Chip tone={STATUS_TONE[c.status]}>{c.status}</Chip>
            </div>
            <div className="text-sm text-ink">{c.title}</div>
            <div className="mt-auto text-xs text-mute">
              {c.jiraKey ?? 'no ticket'} · updated {new Date(c.updatedAt).toLocaleDateString()}
            </div>
          </Card>
        ))}
        <Card onClick={onNew} className="flex min-h-24 items-center justify-center p-4">
          <span role="button" className="text-sm text-dim transition-colors hover:text-ink">
            + New case
          </span>
        </Card>
      </div>
    </div>
  )
}
