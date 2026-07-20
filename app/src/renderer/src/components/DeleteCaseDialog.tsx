import { useState } from 'react'
import { ModalShell } from './ModalShell'

/** Type-the-slug confirmation — case deletion is the highest-blast-radius action in the app. */
export function DeleteCaseDialog({
  slug,
  onCancel,
  onDeleted
}: {
  slug: string
  onCancel: () => void
  onDeleted: () => void
}): React.JSX.Element {
  const [typed, setTyped] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const match = typed === slug

  async function confirmDelete(): Promise<void> {
    setBusy(true)
    setError(null)
    try {
      await window.argus.cases.delete(slug)
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
          Permanently deletes the case, its evidence, chats, and findings. This cannot be undone.
          Type <span className="font-mono text-defect">{slug}</span> to confirm.
        </p>
        <input
          autoFocus
          aria-label="Confirm slug"
          className="rounded-r1 border border-hair bg-deep px-2 py-1 font-mono text-xs text-ink outline-none"
          value={typed}
          onChange={(e) => setTyped(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter' && match && !busy) void confirmDelete()
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
          <button
            type="button"
            disabled={!match || busy}
            className="rounded-r2 bg-danger/20 px-2 py-1 text-xs text-danger transition-colors hover:bg-danger/30 disabled:opacity-40"
            onClick={() => void confirmDelete()}
          >
            {busy ? 'Deleting…' : 'Delete case'}
          </button>
        </div>
      </div>
    </ModalShell>
  )
}
