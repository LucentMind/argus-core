import type { ReactNode, KeyboardEvent } from 'react'
import { X } from 'lucide-react'
import { IconBtn } from './ui'
import { useEscapeLayer } from '../lib/escapeLayer'

/**
 * The shared floating-overlay chrome: dimmed backdrop, centered card, header
 * with a title, an actions slot, and a close button.
 *
 * Registers an escape layer, so Escape closes the topmost open shell only.
 */
export function ModalShell({
  title,
  onClose,
  actions,
  children,
  className = 'h-[80vh] w-[80vw]',
  onKeyDown,
  ariaLabel
}: {
  title: ReactNode
  onClose: () => void
  actions?: ReactNode
  children: ReactNode
  className?: string
  /** Extra key handling for the card subtree (e.g. TextViewer's Ctrl/Cmd+F). */
  onKeyDown?: (e: KeyboardEvent) => void
  ariaLabel?: string
}): React.JSX.Element {
  useEscapeLayer({ onEscape: onClose })

  return (
    <div
      data-testid="modal-backdrop"
      className="fixed inset-0 z-30 flex items-center justify-center bg-black/60 backdrop-blur-[2px]"
      onClick={onClose}
      onKeyDown={onKeyDown}
      tabIndex={-1}
    >
      <div
        role="dialog"
        aria-label={ariaLabel}
        className={`flex flex-col rounded-r4 border border-hair2 bg-panel shadow-2xl ${className}`}
        onClick={(e) => e.stopPropagation()}
      >
        <div className="flex items-center justify-between border-b border-hair px-3 py-2">
          <span className="flex items-center gap-2 font-mono text-sm text-ink">{title}</span>
          <span className="flex items-center gap-2">
            {actions}
            <IconBtn aria-label="Close" title="Close" onClick={onClose}>
              <X size={14} />
            </IconBtn>
          </span>
        </div>
        {children}
      </div>
    </div>
  )
}
