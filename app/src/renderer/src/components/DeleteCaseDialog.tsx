import { useState } from 'react'
import { ModalShell } from './ModalShell'

/**
 * Type-the-slug confirmation — case deletion is the highest-blast-radius action in the app.
 *
 * Two shapes, because archiving made "what a delete destroys" case-dependent:
 *  - never archived: one action. Everything goes — evidence, transcripts, the case directory,
 *    the findings/RCA/summary — and there is nothing anywhere to fall back on.
 *  - archived: two actions, the SAME pair the case anchor's `choose()` prompt offers. The
 *    bundle in `<argusHome>/archive/` holds precisely the evidence and chats the old single
 *    sentence claimed were "permanently deleted", and `cases.delete` defaults `deleteArchive`
 *    to false — so without this choice the dashboard could never remove the bundle, and once
 *    the row was gone the case appeared nowhere and the orphan was reachable only from the
 *    filesystem.
 *
 * The type-the-slug guard is unchanged and gates both actions.
 */
export function DeleteCaseDialog({
  slug,
  archivedAt = null,
  onCancel,
  onDeleted
}: {
  slug: string
  /** `CaseRecord.archivedAt` — non-null means there is a bundle on disk, and therefore a second
   *  question to ask. Defaulted so a caller that has no record still gets the truthful
   *  never-archived copy rather than the archived copy by accident. */
  archivedAt?: string | null
  onCancel: () => void
  onDeleted: () => void
}): React.JSX.Element {
  const [typed, setTyped] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const match = typed === slug

  async function confirmDelete(deleteArchive: boolean): Promise<void> {
    setBusy(true)
    setError(null)
    try {
      await window.argus.cases.delete(slug, { deleteArchive })
      onDeleted()
    } catch (err) {
      setError((err as Error).message)
      setBusy(false)
    }
  }

  return (
    <ModalShell
      title={`Delete case ${slug}?`}
      ariaLabel={`Delete case ${slug}`}
      onClose={onCancel}
      className="w-96"
    >
      <div className="flex flex-col gap-3 p-4">
        <p className="text-xs text-dim">
          {archivedAt
            ? 'Permanently deletes the case and its findings, RCA and summary. Its evidence and chats are in the archive bundle: "Delete everything" removes that too, "Keep the archive" leaves the zip on disk. Either way this cannot be undone. '
            : 'Permanently deletes the case, its evidence, chats, and findings. There is no archive bundle for this case, so nothing is kept. This cannot be undone. '}
          Type <span className="font-mono text-defect">{slug}</span> to confirm.
        </p>
        <input
          autoFocus
          aria-label="Confirm slug"
          className="rounded-r1 border border-hair bg-overlay px-2 py-1 font-mono text-xs text-ink outline-none"
          value={typed}
          onChange={(e) => setTyped(e.target.value)}
          onKeyDown={(e) => {
            // Enter takes the SAFER of the two archived actions (keep the bundle): losing the
            // zip must be a deliberate click, never a keystroke. On a never-archived case there
            // is no bundle, so the flag is false there for the honest reason.
            if (e.key === 'Enter' && match && !busy) void confirmDelete(false)
            // Destructive-confirm carve-out (spec §2): this field autofocuses, so the
            // escape-layer dispatcher never sees Escape here. Cancelling from the field
            // is the only thing keeping the dialog dismissible.
            if (e.key === 'Escape') onCancel()
          }}
        />
        {error && <p className="text-xs text-danger">{error}</p>}
        <div className="flex justify-end gap-2">
          <button
            type="button"
            className="rounded-r2 px-2 py-1 text-xs text-dim transition-colors hover:bg-hair hover:text-ink"
            onClick={onCancel}
          >
            Cancel
          </button>
          {archivedAt && (
            <button
              type="button"
              disabled={!match || busy}
              className="rounded-r2 bg-danger/20 px-2 py-1 text-xs text-danger transition-colors hover:bg-danger/30 disabled:opacity-40"
              onClick={() => void confirmDelete(false)}
            >
              {busy ? 'Deleting…' : 'Keep the archive'}
            </button>
          )}
          <button
            type="button"
            disabled={!match || busy}
            className="rounded-r2 bg-danger/20 px-2 py-1 text-xs text-danger transition-colors hover:bg-danger/30 disabled:opacity-40"
            onClick={() => void confirmDelete(Boolean(archivedAt))}
          >
            {busy ? 'Deleting…' : archivedAt ? 'Delete everything' : 'Delete case'}
          </button>
        </div>
      </div>
    </ModalShell>
  )
}
