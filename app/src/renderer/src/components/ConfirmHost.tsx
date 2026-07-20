import { ModalShell } from './ModalShell'
import { Btn } from './ui'
import { confirmStore, useConfirmState } from '../lib/confirmStore'

/**
 * Renders the app's single confirm/alert dialog in Argus styling. Mounted once at
 * the root; driven imperatively by {@link confirm}/{@link alert}. Escape and
 * backdrop clicks cancel (via ModalShell), matching native `confirm` semantics.
 */
export function ConfirmHost(): React.JSX.Element | null {
  const { current } = useConfirmState()
  if (!current) return null

  const { id, title, message, confirmLabel, cancelLabel, danger, acknowledge } = current
  const cancel = (): void => confirmStore.settle(id, false)
  const ok = (): void => confirmStore.settle(id, true)

  return (
    <ModalShell
      title={title}
      ariaLabel={typeof title === 'string' ? title : 'Confirm'}
      onClose={cancel}
      overlayZClassName="z-[70]"
      className="w-96"
    >
      <div className="flex flex-col gap-4 p-4">
        {message != null && <p className="text-xs leading-relaxed text-dim">{message}</p>}
        <div className="flex justify-end gap-2">
          {!acknowledge && (
            <Btn variant="ghost" onClick={cancel}>
              {cancelLabel ?? 'Cancel'}
            </Btn>
          )}
          <Btn autoFocus variant={danger ? 'danger' : 'primary'} onClick={ok}>
            {confirmLabel ?? (acknowledge ? 'OK' : 'Confirm')}
          </Btn>
        </div>
      </div>
    </ModalShell>
  )
}
