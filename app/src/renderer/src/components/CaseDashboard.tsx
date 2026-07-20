import { useEffect, useState } from 'react'
import type { CaseRecord } from '../../../shared/types'
import { Card, SectionLabel } from './ui'
import { FolderInput, Plus } from 'lucide-react'
import { CaseCard } from './CaseCard'
import { DeleteCaseDialog } from './DeleteCaseDialog'
import { useSettingsPayload } from '../lib/settingsStore'

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
  const [pendingKnowledge, setPendingKnowledge] = useState(0)
  const settings = useSettingsPayload()

  useEffect(() => {
    let mounted = true
    window.argus.proposals
      .list()
      .then((p) => {
        if (mounted) setPendingKnowledge(p.proposals.length)
      })
      .catch(() => undefined)
    return () => {
      mounted = false
    }
  }, [])

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
        {pendingKnowledge > 0 && (
          <p className="text-xs text-dim">Knowledge review pending: {pendingKnowledge}</p>
        )}
      </div>
      <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-3">
        {cases.map((c) => (
          <CaseCard
            key={c.slug}
            c={c}
            onOpen={onOpen}
            onExport={(slug) => void exportCase(slug)}
            onDelete={(slug) => void requestDelete(slug)}
            note={
              deleteError?.slug === c.slug
                ? { text: deleteError.text, danger: true }
                : exportNote?.slug === c.slug
                  ? { text: exportNote.text, danger: false }
                  : null
            }
          />
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
