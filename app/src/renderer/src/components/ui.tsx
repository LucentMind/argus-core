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
  children
}: {
  tone?: keyof typeof CHIP_TONES
  children: ReactNode
}): React.JSX.Element {
  return (
    <span
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
  'inline-flex h-7 items-center gap-1.5 whitespace-nowrap rounded-r2 border px-3 text-xs font-medium transition-colors disabled:opacity-40'

const BTN_VARIANTS = {
  primary: 'border-transparent bg-signal text-[#001020] hover:bg-[#a8d7ff]',
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
      className={`inline-flex h-7 w-7 items-center justify-center rounded-r2 text-dim transition-colors hover:bg-hair hover:text-ink disabled:opacity-40 ${className}`}
    />
  )
}

export interface MenuItem {
  label: string
  onSelect: () => void
  tone?: 'default' | 'danger'
  disabled?: boolean
}

/** Button + anchored dropdown menu. Closes on select, Escape, or outside click. */
export function MenuButton({
  label,
  items,
  variant = 'ghost',
  'aria-label': ariaLabel
}: {
  label: React.ReactNode
  items: MenuItem[]
  variant?: 'primary' | 'ghost' | 'outline'
  'aria-label'?: string
}): React.JSX.Element {
  const [open, setOpen] = useState(false)
  const ref = useRef<HTMLDivElement>(null)
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
        onClick={() => setOpen((o) => !o)}
        aria-label={ariaLabel}
        aria-haspopup="menu"
        aria-expanded={open}
      >
        {label} <span aria-hidden="true">▾</span>
      </Btn>
      {open && (
        <div
          role="menu"
          className="absolute right-0 z-20 mt-1 min-w-44 rounded-r2 border border-hair bg-deep p-1 shadow-lg"
        >
          {items.map((it) => (
            <button
              key={it.label}
              role="menuitem"
              disabled={it.disabled}
              className={`block w-full rounded-r2 px-3 py-1.5 text-left text-sm hover:bg-hair/50 disabled:opacity-50 ${
                it.tone === 'danger' ? 'text-danger' : 'text-ink'
              }`}
              onClick={() => {
                setOpen(false)
                it.onSelect()
              }}
            >
              {it.label}
            </button>
          ))}
        </div>
      )}
    </div>
  )
}
