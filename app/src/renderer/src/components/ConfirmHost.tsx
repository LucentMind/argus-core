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

  const {
    id,
    title,
    message,
    confirmLabel,
    cancelLabel,
    danger,
    altLabel,
    altDanger,
    acknowledge
  } = current
  const cancel = (): void => confirmStore.settle(id, 'cancel')
  const ok = (): void => confirmStore.settle(id, 'confirm')
  const alt = (): void => confirmStore.settle(id, 'alt')

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
        {/* `flex-wrap` + `justify-end`: a three-button row can outgrow the w-96 dialog once the
            labels get long ("Discard & close" beside "Keep drafts & close"), and wrapping keeps
            the buttons at their natural width instead of squeezing every label to min-content. */}
        <div className="flex flex-wrap justify-end gap-2">
          {!acknowledge && (
            <Btn variant="ghost" onClick={cancel}>
              {cancelLabel ?? 'Cancel'}
            </Btn>
          )}
          {altLabel != null && (
            <Btn variant={altDanger ? 'danger' : 'outline'} onClick={alt}>
              {altLabel}
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
