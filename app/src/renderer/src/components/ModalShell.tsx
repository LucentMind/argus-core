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
  overlayZClassName = 'z-30',
  onKeyDown,
  ariaLabel,
  variant = 'chrome'
}: {
  title: ReactNode
  onClose: () => void
  actions?: ReactNode
  children: ReactNode
  className?: string
  /** Stacking layer for the backdrop. Confirm/alert dialogs raise this so they
   *  sit above a settings modal that spawned them. Defaults to the base modal layer. */
  overlayZClassName?: string
  /** Extra key handling for the card subtree (e.g. TextViewer's Ctrl/Cmd+F). */
  onKeyDown?: (e: KeyboardEvent) => void
  ariaLabel?: string
  /** 'chrome' (default) is `.overlay-card` — frosted in light, flat in dark (`--bg-2` /
   *  `--hair-2` / shadow-2xl) — for controls, confirms and forms. 'reading' is `.glass-panel` —
   *  the same solid material the editor's writing sheets use, dark `--panel-bg` (#090b0e) /
   *  `--panel-border` / `--panel-shadow` with a bevel and waist — for a body that is dense text
   *  the user is there to read: nothing read sits behind a blur (Task 12). */
  variant?: 'chrome' | 'reading'
}): React.JSX.Element {
  useEscapeLayer({ onEscape: onClose })
  const material = variant === 'reading' ? 'glass-panel' : 'overlay-card'

  return (
    <div
      data-testid="modal-backdrop"
      className={`fixed inset-0 flex items-center justify-center modal-scrim backdrop-blur-[2px] ${overlayZClassName}`}
      onClick={onClose}
      onKeyDown={onKeyDown}
      tabIndex={-1}
    >
      {/* Default 'chrome' variant: `overlay-card` (main.css) owns the whole look — flat in dark
          (reproducing the former hairline-border, panel-fill, deep-shadow trio exactly), frosted
          in light. 'reading' variant: `glass-panel` (theme.css material tokens) — solid in both
          themes, never blurred, for a body the user is there to read. */}
      <div
        role="dialog"
        aria-label={ariaLabel}
        className={`flex flex-col rounded-r4 ${material} ${className}`}
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
