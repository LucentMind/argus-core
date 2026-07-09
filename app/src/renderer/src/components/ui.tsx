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
      className={`inline-flex items-center gap-1 rounded-r1 border px-1.5 py-0.5 font-mono text-[11px] uppercase tracking-wide ${CHIP_TONES[tone]}`}
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
      className={`rounded-r3 border border-hair bg-panel ${onClick ? 'cursor-pointer transition-colors hover:bg-overlay' : ''} ${className}`}
    >
      {children}
    </div>
  )
}

export function SectionLabel({ children }: { children: ReactNode }): React.JSX.Element {
  return (
    <div className="font-mono text-[11px] uppercase tracking-widest text-mute">{children}</div>
  )
}

const BTN_VARIANTS = {
  primary: 'bg-defect text-void hover:bg-defect/85',
  ghost: 'border border-hair text-dim hover:bg-overlay hover:text-ink',
  danger: 'border border-danger/40 text-danger hover:bg-danger/10'
} as const

export function Btn({
  variant = 'ghost',
  className = '',
  ...props
}: ButtonHTMLAttributes<HTMLButtonElement> & {
  variant?: keyof typeof BTN_VARIANTS
}): React.JSX.Element {
  return (
    <button
      {...props}
      className={`rounded-r2 px-3 py-1.5 text-sm font-medium transition-colors disabled:opacity-40 ${BTN_VARIANTS[variant]} ${className}`}
    />
  )
}
