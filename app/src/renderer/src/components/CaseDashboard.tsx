import { useState } from 'react'
import type { CaseRecord, CaseStatus, NewCaseInput } from '../../../shared/types'
import { Card, Chip, SectionLabel, Btn } from './ui'

const STATUS_TONE: Record<CaseStatus, 'signal' | 'defect' | 'review' | 'neutral'> = {
  open: 'signal',
  analyzing: 'defect',
  'rca-drafted': 'review',
  closed: 'neutral'
}

const INPUT =
  'h-8 rounded-r2 border border-hair bg-overlay px-2.5 text-sm text-ink placeholder:text-mute transition-colors focus:border-hair2'

export function CaseDashboard({
  cases,
  onOpen,
  onCreate
}: {
  cases: CaseRecord[]
  onOpen: (slug: string) => void
  onCreate: (input: NewCaseInput) => void
}): React.JSX.Element {
  const [slug, setSlug] = useState('')
  const [title, setTitle] = useState('')
  const [jira, setJira] = useState('')

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
        <Card className="flex flex-col gap-2 p-4">
          <SectionLabel>New case</SectionLabel>
          <input
            className={`${INPUT} font-mono`}
            placeholder="slug (e.g. NAVAPI-123)"
            value={slug}
            onChange={(e) => setSlug(e.target.value)}
          />
          <input
            className={INPUT}
            placeholder="title"
            value={title}
            onChange={(e) => setTitle(e.target.value)}
          />
          <input
            className={`${INPUT} font-mono`}
            placeholder="jira key (optional)"
            value={jira}
            onChange={(e) => setJira(e.target.value)}
          />
          <Btn
            variant="primary"
            className="justify-center"
            disabled={!slug || !title}
            onClick={() => {
              onCreate({ slug, title, jiraKey: jira || undefined })
              setSlug('')
              setTitle('')
              setJira('')
            }}
          >
            Create case
          </Btn>
        </Card>
      </div>
    </div>
  )
}
