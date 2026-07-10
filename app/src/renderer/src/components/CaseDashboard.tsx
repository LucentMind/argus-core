import { useState } from 'react'
import type { CaseRecord, CaseStatus } from '../../../shared/types'
import { Btn, Card, Chip, SectionLabel } from './ui'

const STATUS_TONE: Record<CaseStatus, 'signal' | 'defect' | 'review' | 'neutral'> = {
  open: 'signal',
  analyzing: 'defect',
  'rca-drafted': 'review',
  closed: 'neutral'
}

export function CaseDashboard({
  cases,
  onOpen,
  onNew,
  onImport
}: {
  cases: CaseRecord[]
  onOpen: (slug: string) => void
  onNew: () => void
  onImport: () => void
}): React.JSX.Element {
  const [exportNote, setExportNote] = useState<{ slug: string; text: string } | null>(null)

  async function exportCase(slug: string): Promise<void> {
    setExportNote(null)
    const r = await window.argus.bundle.export(slug, true)
    if (!r) return // save dialog canceled
    setExportNote({ slug, text: r.ok ? `exported ${r.fileCount} files` : r.error })
  }

  return (
    <div className="mx-auto flex w-full max-w-[1400px] flex-col gap-6 p-8">
      <div className="flex flex-col gap-1">
        <SectionLabel>Cases · {cases.length} total</SectionLabel>
        <h1 className="text-2xl font-semibold tracking-tight text-ink">Argus</h1>
        <p className="text-sm text-dim">Defect analysis workbench</p>
      </div>
      <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-3">
        {cases.map((c) => (
          <Card
            key={c.slug}
            onClick={() => onOpen(c.slug)}
            className="group flex flex-col gap-2 p-4"
          >
            <div className="flex items-center justify-between">
              <span className="font-mono text-sm text-defect">{c.slug}</span>
              <span className="flex items-center gap-1.5">
                <Btn
                  variant="ghost"
                  aria-label={`Export ${c.slug}`}
                  className="opacity-0 transition-opacity focus-visible:opacity-100 group-hover:opacity-100"
                  onClick={(e) => {
                    e.stopPropagation() // the Card itself opens the case
                    void exportCase(c.slug)
                  }}
                >
                  Export
                </Btn>
                <Chip tone={STATUS_TONE[c.status]}>{c.status}</Chip>
              </span>
            </div>
            <div className="text-sm text-ink">{c.title}</div>
            <div className="mt-auto text-xs text-mute">
              {exportNote?.slug === c.slug ? (
                <span className="truncate" title={exportNote.text}>
                  {exportNote.text}
                </span>
              ) : (
                <>
                  {c.jiraKey ?? 'no ticket'} · updated {new Date(c.updatedAt).toLocaleDateString()}
                </>
              )}
            </div>
          </Card>
        ))}
        <Card onClick={onNew} className="flex min-h-24 items-center justify-center p-4">
          <span role="button" className="text-sm text-dim transition-colors hover:text-ink">
            + New case
          </span>
        </Card>
        <Card onClick={onImport} className="flex min-h-24 items-center justify-center p-4">
          <span role="button" className="text-sm text-dim transition-colors hover:text-ink">
            ⤓ Import case…
          </span>
        </Card>
      </div>
    </div>
  )
}
