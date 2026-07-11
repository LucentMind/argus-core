import { useState } from 'react'
import type { CaseRecord, CaseStatus } from '../../../shared/types'
import { Card, Chip, IconBtn, SectionLabel } from './ui'
import { Download, FolderInput, Plus, Trash2 } from 'lucide-react'
import { DeleteCaseDialog } from './DeleteCaseDialog'
import { useSettingsPayload } from '../lib/settingsStore'

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
  onImport,
  onDeleted
}: {
  cases: CaseRecord[]
  onOpen: (slug: string) => void
  onNew: () => void
  onImport: () => void
  onDeleted: () => void
}): React.JSX.Element {
  const [exportNote, setExportNote] = useState<{ slug: string; text: string } | null>(null)
  const [deleteError, setDeleteError] = useState<{ slug: string; text: string } | null>(null)
  const [deleting, setDeleting] = useState<string | null>(null)
  const settings = useSettingsPayload()

  async function exportCase(slug: string): Promise<void> {
    setExportNote(null)
    const r = await window.argus.bundle.export(slug, true)
    if (!r) return // save dialog canceled
    setExportNote({ slug, text: r.ok ? `exported ${r.fileCount} files` : r.error })
  }

  async function requestDelete(slug: string): Promise<void> {
    // default true — also while the settings payload is still loading
    const confirm = settings?.settings.general.confirmCaseDelete ?? true
    if (!confirm) {
      setDeleteError(null)
      try {
        await window.argus.cases.delete(slug)
      } catch (err) {
        setDeleteError({ slug, text: (err as Error).message })
      } finally {
        // resync the list even on failure — the deletion may have partially committed
        onDeleted()
      }
      return
    }
    setDeleting(slug)
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
                <IconBtn
                  aria-label={`Export ${c.slug}`}
                  title="Export case"
                  className="opacity-0 transition-opacity focus-visible:opacity-100 group-hover:opacity-100"
                  onClick={(e) => {
                    e.stopPropagation() // the Card itself opens the case
                    void exportCase(c.slug)
                  }}
                >
                  <Download size={14} />
                </IconBtn>
                <IconBtn
                  aria-label={`Delete ${c.slug}`}
                  title="Delete case"
                  className="opacity-0 transition-opacity focus-visible:opacity-100 group-hover:opacity-100"
                  onClick={(e) => {
                    e.stopPropagation() // the Card itself opens the case
                    void requestDelete(c.slug)
                  }}
                >
                  <Trash2 size={14} />
                </IconBtn>
                <Chip tone={STATUS_TONE[c.status]}>
                  {c.status === 'closed' && c.resolution ? `closed · ${c.resolution}` : c.status}
                </Chip>
              </span>
            </div>
            <div className="text-sm text-ink">{c.title}</div>
            <div className="mt-auto text-xs text-mute">
              {deleteError?.slug === c.slug ? (
                <span className="truncate text-danger" title={deleteError.text}>
                  {deleteError.text}
                </span>
              ) : exportNote?.slug === c.slug ? (
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
        <Card className="flex min-h-24 flex-col items-stretch divide-y divide-hair p-0">
          <button
            onClick={onNew}
            className="flex flex-1 items-center justify-center gap-2 rounded-t-r3 text-sm text-dim transition-colors hover:bg-hi hover:text-ink"
          >
            <Plus size={14} aria-hidden="true" /> New case
          </button>
          <button
            onClick={onImport}
            className="flex flex-1 items-center justify-center gap-2 rounded-b-r3 text-sm text-dim transition-colors hover:bg-hi hover:text-ink"
          >
            <FolderInput size={14} aria-hidden="true" /> Import case…
          </button>
        </Card>
      </div>
      {deleting && (
        <DeleteCaseDialog
          slug={deleting}
          onCancel={() => setDeleting(null)}
          onDeleted={() => {
            setDeleting(null)
            onDeleted()
          }}
        />
      )}
    </div>
  )
}
