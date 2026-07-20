import { useState } from 'react'
import { Btn, Chip } from './ui'
import { ModalShell } from './ModalShell'
import type { BundleInspection } from '../../../shared/bundle'

export type ImportDialogState = { inspection: BundleInspection } | { error: string }

export function ImportCaseDialog({
  state,
  onClose,
  onImported
}: {
  state: ImportDialogState
  onClose: () => void
  onImported: (slug: string) => void
}): React.JSX.Element {
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>('error' in state ? state.error : null)
  const insp = 'inspection' in state ? state.inspection : null

  async function confirm(): Promise<void> {
    if (!insp || busy) return
    setBusy(true)
    setError(null)
    const r = await window.argus.bundle.import(insp.zipPath, insp.proposedSlug)
    setBusy(false)
    if (!r.ok) {
      setError(r.error)
      return
    }
    onImported(r.record.slug)
  }

  return (
    <ModalShell
      title="Import case"
      ariaLabel="Import case"
      onClose={onClose}
      className="max-h-[85vh] w-[480px]"
    >
      <div className="flex min-h-0 flex-1 flex-col gap-3 overflow-y-auto p-4">
        {error && (
          <div
            role="alert"
            className="rounded-r2 border border-danger/40 bg-danger/10 px-3 py-2 text-xs text-ink"
          >
            {error}
          </div>
        )}

        {insp && (
          <>
            <div className="flex items-center gap-2 text-sm">
              <span className="font-mono text-defect">{insp.proposedSlug}</span>
              <span className="truncate text-dim">{insp.manifest.title}</span>
            </div>
            {insp.collision && (
              <div className="text-xs text-review">
                {insp.manifest.slug} already exists here — importing as {insp.proposedSlug}.
              </div>
            )}
            <div className="flex flex-wrap items-center gap-2">
              <Chip tone="neutral">{insp.manifest.files.length} files</Chip>
              <Chip tone="neutral">
                {insp.manifest.includesTranscripts ? 'transcripts included' : 'no transcripts'}
              </Chip>
              {insp.manifest.workspaces.length > 0 && (
                <Chip tone="neutral">{insp.manifest.workspaces.length} repo refs</Chip>
              )}
              <Chip tone="neutral">from Argus {insp.manifest.argusVersion}</Chip>
            </div>
            <div className="text-xs text-mute">
              Evidence is re-indexed on import; linked repos arrive as unlinked references.
            </div>
            <Btn
              variant="primary"
              className="justify-center"
              disabled={busy}
              onClick={() => void confirm()}
            >
              {busy ? 'Importing…' : `Import as ${insp.proposedSlug}`}
            </Btn>
          </>
        )}
      </div>
    </ModalShell>
  )
}
