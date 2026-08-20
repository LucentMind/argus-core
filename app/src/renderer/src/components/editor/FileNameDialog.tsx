import { useState } from 'react'
import { ModalShell } from '../ModalShell'
import { Btn } from '../ui'
import { assetPathError } from '../../../../shared/skillAssets'

/**
 * The relative-path counterpart to `ForkSkillDialog`: `confirm()` (lib/confirmStore) carries no
 * input field, and adding one or renaming one both need a POSIX path from the user. One dialog
 * serves both — the only difference is the initial value and the button label.
 *
 * Validated locally with the same `assetPathError` main re-runs (shared/skillAssets.ts), so a
 * typo is caught before a round trip — but that is an affordance only; the write/rename IPC is
 * still the boundary that can refuse (e.g. "already exists", a tier that turned read-only mid
 * session).
 */
export function FileNameDialog({
  title,
  confirmLabel,
  initialValue,
  onCancel,
  onConfirm
}: {
  title: string
  confirmLabel: string
  initialValue: string
  onCancel: () => void
  /** Rejects with the error to show inline, exactly like `ForkSkillDialog`'s `onConfirm`. */
  onConfirm: (relPath: string) => Promise<void>
}): React.JSX.Element {
  const [value, setValue] = useState(initialValue)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)

  async function submit(): Promise<void> {
    if (busy) return
    const trimmed = value.trim()
    const bad = assetPathError(trimmed)
    if (bad) {
      setError(bad)
      return
    }
    setBusy(true)
    setError(null)
    try {
      await onConfirm(trimmed)
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err))
      setBusy(false)
    }
  }

  return (
    <ModalShell title={title} ariaLabel={title} onClose={onCancel} className="w-96">
      <div className="flex flex-col gap-3 p-4">
        <label className="flex flex-col gap-1 text-xs text-dim">
          Path
          <input
            aria-label="File path"
            autoFocus
            disabled={busy}
            className="h-8 rounded-r2 border border-hair bg-overlay px-2 font-mono text-sm text-ink outline-none"
            value={value}
            onChange={(e) => {
              setValue(e.target.value)
              setError(null)
            }}
            onKeyDown={(e) => {
              if (e.key === 'Enter') void submit()
            }}
          />
        </label>
        {error && (
          <p role="alert" className="text-xs text-danger">
            {error}
          </p>
        )}
        <div className="flex justify-end gap-2">
          <Btn variant="ghost" onClick={onCancel} disabled={busy}>
            Cancel
          </Btn>
          <Btn variant="primary" onClick={() => void submit()} disabled={busy || !value.trim()}>
            {busy ? 'Working…' : confirmLabel}
          </Btn>
        </div>
      </div>
    </ModalShell>
  )
}
