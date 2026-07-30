import { useState } from 'react'
import { ModalShell } from '../ModalShell'
import { Btn } from '../ui'
import { ASSET_NAME_RE } from '../../../../shared/assetValidation'

/**
 * "Edit a copy" for a skill you don't own: forking is how a user gets a *private variant*
 * instead of a PR against the team's copy, and the fork's name is what makes that variant
 * distinct. `confirm()` (lib/confirmStore) only carries a title/message/button pair — no
 * input — so this is a small dedicated dialog rather than bending it out of shape.
 *
 * Name defaults to the source name (fork-in-place, the pre-existing behaviour); the user can
 * change it before the copy is made. Validation and the fork call both happen here so a
 * rejected name (illegal, or a collision `forkSkill` refuses) surfaces inline and the dialog
 * stays open for another try, instead of dumping the user back on the page with a banner.
 */
export function ForkSkillDialog({
  sourceName,
  tier,
  onCancel,
  onConfirm
}: {
  sourceName: string
  tier: 'bundled' | 'user' | 'hivemind'
  onCancel: () => void
  /** Forks the skill under `newName`. Rejects with the error to show inline. */
  onConfirm: (newName: string) => Promise<void>
}): React.JSX.Element {
  const [name, setName] = useState(sourceName)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)

  async function submit(): Promise<void> {
    if (busy) return
    const trimmed = name.trim()
    if (!ASSET_NAME_RE.test(trimmed)) {
      setError(`"${trimmed}" is not a legal skill name.`)
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

  const title = `Edit your own copy of "${sourceName}"?`
  return (
    <ModalShell title={title} ariaLabel={title} onClose={onCancel} className="w-96">
      <div className="flex flex-col gap-3 p-4">
        <p className="text-xs leading-relaxed text-dim">
          {tier === 'hivemind'
            ? 'A copy lands in your skills and overrides the HiveMind version. "Adopt upstream" undoes it.'
            : 'A copy lands in your skills and overrides the bundled version. Deleting it restores the pack copy.'}
        </p>
        <label className="flex flex-col gap-1 text-xs text-dim">
          Name
          <input
            aria-label="New skill name"
            autoFocus
            disabled={busy}
            className="h-8 rounded-r2 border border-hair bg-overlay px-2 text-sm text-ink outline-none"
            value={name}
            onChange={(e) => {
              setName(e.target.value)
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
          <Btn variant="primary" onClick={() => void submit()} disabled={busy || !name.trim()}>
            {busy ? 'Copying…' : 'Copy'}
          </Btn>
        </div>
      </div>
    </ModalShell>
  )
}
