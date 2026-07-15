import { useState, useRef, useEffect } from 'react'
import type { ButtonHTMLAttributes, ReactNode } from 'react'

const CHIP_TONES = {
  neutral: 'text-dim border-hair',
  defect: 'text-defect border-defect/30',
  danger: 'text-danger border-danger/30',
  signal: 'text-signal border-signal/30',
  review: 'text-review border-review/30'
} as const

export function Chip({
  tone = 'neutral',
  title,
  children
}: {
  tone?: keyof typeof CHIP_TONES
  title?: string
  children: ReactNode
}): React.JSX.Element {
  return (
    <span
      title={title}
      className={`inline-flex items-center gap-1 rounded-r1 border bg-hair/50 px-1.5 py-0.5 font-mono text-[10.5px] uppercase tracking-wide ${CHIP_TONES[tone]}`}
    >
      {children}
    </span>
  )
}

export function Card({
  className = '',
  onClick,
  children
}: {
  className?: string
  onClick?: () => void
  children: ReactNode
}): React.JSX.Element {
  return (
    <div
      onClick={onClick}
      className={`rounded-r3 border border-hair bg-panel transition-colors ${onClick ? 'cursor-pointer hover:border-hair2 hover:bg-hi' : ''} ${className}`}
    >
      {children}
    </div>
  )
}

export function SectionLabel({ children }: { children: ReactNode }): React.JSX.Element {
  return (
    <div className="font-mono text-[10.5px] font-medium uppercase tracking-[0.1em] text-mute">
      {children}
    </div>
  )
}

/* One size for every button so mixed rows stay aligned (OEH .btn). */
const BTN_BASE =
  'inline-flex h-7 shrink-0 items-center leading-none gap-1.5 whitespace-nowrap rounded-r2 border px-3 text-xs font-medium transition-colors disabled:opacity-40'

const BTN_VARIANTS = {
  primary: 'border-transparent bg-signal text-void transition-all hover:brightness-110',
  ghost: 'border-transparent text-dim hover:bg-hair hover:text-ink',
  outline: 'border-hair2 text-ink hover:border-faint hover:bg-hair',
  danger: 'border-danger/40 text-danger hover:bg-danger/10'
} as const

export function Btn({
  variant = 'outline',
  className = '',
  ...props
}: ButtonHTMLAttributes<HTMLButtonElement> & {
  variant?: keyof typeof BTN_VARIANTS
}): React.JSX.Element {
  return <button {...props} className={`${BTN_BASE} ${BTN_VARIANTS[variant]} ${className}`} />
}

/* Small square icon button for top-bar controls. */
export function IconBtn({
  className = '',
  ...props
}: ButtonHTMLAttributes<HTMLButtonElement>): React.JSX.Element {
  return (
    <button
      {...props}
      className={`inline-flex h-7 w-7 shrink-0 items-center justify-center rounded-r2 text-dim transition-colors hover:bg-hair hover:text-ink disabled:opacity-40 ${className}`}
    />
  )
}

export interface MenuItem {
  label: string
  /** Leaf action. Omitted on parent items that only carry a submenu. */
  onSelect?: () => void
  tone?: 'default' | 'danger'
  disabled?: boolean
  /** When present, this row is a submenu parent: selecting is replaced by
   *  revealing these nested items (one level of nesting). */
  children?: MenuItem[]
}

const MENU_ITEM_BASE = 'block w-full rounded-r2 px-3 py-1.5 text-left text-sm hover:bg-hair/50'

/** Button + anchored dropdown menu. Closes on select, Escape, or outside click.
 *  Items with `children` expand into a nested submenu on hover or click. */
export function MenuButton({
  label,
  items,
  variant = 'ghost',
  align = 'right',
  onOpenChange,
  triggerClassName = '',
  'aria-label': ariaLabel
}: {
  label: React.ReactNode
  items: MenuItem[]
  variant?: 'primary' | 'ghost' | 'outline'
  /** Which edge the dropdown anchors to. 'right' opens leftward (default, for
   *  right-aligned triggers); 'left' opens rightward so triggers near the left
   *  screen edge don't clip. */
  align?: 'left' | 'right'
  /** Notified whenever the dropdown opens/closes. Used by callers (e.g. the panel launcher)
   *  that must hide a native overlay while the DOM menu is up. Also fired false on unmount. */
  onOpenChange?: (open: boolean) => void
  /** Extra classes for the trigger button, e.g. to keep a case-id trigger looking
   *  like its heading rather than a generic button. */
  triggerClassName?: string
  'aria-label'?: string
}): React.JSX.Element {
  const [open, setOpen] = useState(false)
  const [openUp, setOpenUp] = useState(false)
  // Index of the currently-expanded submenu parent, or null.
  const [openSub, setOpenSub] = useState<number | null>(null)
  const ref = useRef<HTMLDivElement>(null)
  useEffect(() => {
    onOpenChange?.(open)
    return () => {
      if (open) onOpenChange?.(false)
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open])
  useEffect(() => {
    if (!open) return
    const onDoc = (e: MouseEvent): void => {
      if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false)
    }
    const onKey = (e: KeyboardEvent): void => {
      if (e.key === 'Escape') setOpen(false)
    }
    document.addEventListener('mousedown', onDoc)
    document.addEventListener('keydown', onKey)
    return () => {
      document.removeEventListener('mousedown', onDoc)
      document.removeEventListener('keydown', onKey)
    }
  }, [open])
  return (
    <div className="relative" ref={ref}>
      <Btn
        variant={variant}
        onClick={() => {
          // Flip upward when there isn't room below (e.g. trigger sits near the bottom of
          // the settings panel) so the menu never renders off-screen or under other chrome.
          const rect = ref.current?.getBoundingClientRect()
          setOpenUp(Boolean(rect && window.innerHeight - rect.bottom < 220 && rect.top > 220))
          // reset any expanded submenu so each open starts collapsed
          setOpenSub(null)
          setOpen((o) => !o)
        }}
        aria-label={ariaLabel}
        aria-haspopup="menu"
        aria-expanded={open}
        className={triggerClassName}
      >
        {label} <span aria-hidden="true">▾</span>
      </Btn>
      {open && (
        <div
          role="menu"
          className={`absolute z-30 min-w-44 rounded-r2 border border-hair bg-deep p-1 shadow-lg ${
            openUp ? 'bottom-full mb-1' : 'mt-1'
          } ${align === 'left' ? 'left-0' : 'right-0'}`}
        >
          {items.map((it, i) =>
            it.children ? (
              <div
                key={`${i}-${it.label}`}
                className="relative"
                onMouseEnter={() => setOpenSub(i)}
                onMouseLeave={() => setOpenSub(null)}
              >
                <button
                  role="menuitem"
                  aria-haspopup="menu"
                  aria-expanded={openSub === i}
                  className={`flex items-center justify-between ${MENU_ITEM_BASE} text-ink`}
                  onClick={() => setOpenSub((s) => (s === i ? null : i))}
                >
                  <span>{it.label}</span>
                  <span aria-hidden="true" className="ml-3 text-mute">
                    ▸
                  </span>
                </button>
                {openSub === i && (
                  <div
                    role="menu"
                    className="absolute left-full top-0 z-40 ml-1 min-w-44 rounded-r2 border border-hair bg-deep p-1 shadow-lg"
                  >
                    {it.children.map((sub, j) => (
                      <button
                        key={`${j}-${sub.label}`}
                        role="menuitem"
                        disabled={sub.disabled}
                        className={`${MENU_ITEM_BASE} disabled:opacity-50 ${
                          sub.tone === 'danger' ? 'text-danger' : 'text-ink'
                        }`}
                        onClick={() => {
                          setOpen(false)
                          sub.onSelect?.()
                        }}
                      >
                        {sub.label}
                      </button>
                    ))}
                  </div>
                )}
              </div>
            ) : (
              <button
                key={`${i}-${it.label}`}
                role="menuitem"
                disabled={it.disabled}
                className={`${MENU_ITEM_BASE} disabled:opacity-50 ${
                  it.tone === 'danger' ? 'text-danger' : 'text-ink'
                }`}
                onClick={() => {
                  setOpen(false)
                  it.onSelect?.()
                }}
              >
                {it.label}
              </button>
            )
          )}
        </div>
      )}
    </div>
  )
}
